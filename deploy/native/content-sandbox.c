#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* ABI 2 plus seccomp or ABI 3+ with native truncation protection.
 * No fallback to an unrestricted child.
 * Rules follow https://docs.kernel.org/userspace-api/landlock.html.
 * argv: private staging directory, verified absolute executable, executable args.
 */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
static void fail(void) {
    fputs("content_sandbox_unavailable\n", stderr);
    exit(125);
}
/* ABI 2 does not mediate path-based truncate or read-only O_TRUNC opens.
 * Deny those forms with seccomp. Writable opens remain Landlock-mediated;
 * ftruncate requires a writable descriptor, all inherited descriptors are closed.
 */
static void restrict_syscalls(void) {
#define DENY_SYSCALL(number) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#if defined(__x86_64__)
    const unsigned int architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
    const unsigned int architecture = AUDIT_ARCH_AARCH64;
#else
#error Unsupported sandbox architecture
#endif
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
        /* The pinned CLI needs no syscalls introduced after this boundary.
         * Fail closed for newer APIs, including *xattrat metadata setters. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 451, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        /* Landlock does not mediate inode metadata. CLI creates files with their
         * final mode; it has no reason to change metadata of existing inodes. */
#ifdef SYS_chmod
        DENY_SYSCALL(SYS_chmod),
#endif
        DENY_SYSCALL(SYS_fchmod),
        DENY_SYSCALL(SYS_fchmodat),
        DENY_SYSCALL(452), /* fchmodat2 on x86_64 and aarch64 */
#ifdef SYS_chown
        DENY_SYSCALL(SYS_chown),
        DENY_SYSCALL(SYS_lchown),
#endif
        DENY_SYSCALL(SYS_fchown),
        DENY_SYSCALL(SYS_fchownat),
        DENY_SYSCALL(SYS_setxattr),
        DENY_SYSCALL(SYS_lsetxattr),
        DENY_SYSCALL(SYS_fsetxattr),
        DENY_SYSCALL(SYS_removexattr),
        DENY_SYSCALL(SYS_lremovexattr),
        DENY_SYSCALL(SYS_fremovexattr),
#ifdef SYS_utime
        DENY_SYSCALL(SYS_utime),
#endif
#ifdef SYS_utimes
        DENY_SYSCALL(SYS_utimes),
#endif
#ifdef SYS_futimesat
        DENY_SYSCALL(SYS_futimesat),
#endif
        DENY_SYSCALL(SYS_utimensat),
        DENY_SYSCALL(SYS_ioctl),
        /* Async operations must not bypass the synchronous open/truncate filter. */
        DENY_SYSCALL(SYS_io_uring_setup),
        DENY_SYSCALL(SYS_io_uring_enter),
        DENY_SYSCALL(SYS_io_uring_register),
        DENY_SYSCALL(SYS_io_setup),
        DENY_SYSCALL(SYS_io_submit),
        DENY_SYSCALL(SYS_io_getevents),
        DENY_SYSCALL(SYS_io_cancel),
        DENY_SYSCALL(SYS_io_destroy),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_truncate, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat2, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#ifdef SYS_open
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_open, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, O_ACCMODE | O_TRUNC),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_TRUNC, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, O_ACCMODE | O_TRUNC),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, O_TRUNC, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(code) / sizeof(code[0]), .filter = code };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
static void allow_path(int ruleset, const char *path, uint64_t rights, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) { if (optional && errno == ENOENT) return; fail(); }
    struct stat st;
    if (fstat(fd, &st)) fail();
    if (!S_ISDIR(st.st_mode)) rights &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail();
    close(fd);
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        return syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) >= 2 ? 0 : 125;
    }
    if (argc < 3 || argv[1][0] != '/' || argv[2][0] != '/') fail();
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 2) fail();
    char *stage = realpath(argv[1], NULL);
    struct stat st;
    if (!stage || stat(stage, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 0077)) fail();
    const uint64_t read = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    const uint64_t execute = read | LANDLOCK_ACCESS_FS_EXECUTE;
    const uint64_t write = read | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_REFER | (abi >= 3 ? LANDLOCK_ACCESS_FS_TRUNCATE : 0);
    struct landlock_ruleset_attr rules = { .handled_access_fs = (1ULL << (abi >= 3 ? 15 : 14)) - 1 };
    int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
    if (fd < 0) fail();
    allow_path(fd, stage, write, 0);
    allow_path(fd, argv[2], execute, 0);
    allow_path(fd, "/usr", execute, 0);
    allow_path(fd, "/lib", execute, 1);
    allow_path(fd, "/lib64", execute, 1);
    allow_path(fd, "/etc/ssl", read, 1);
    allow_path(fd, "/etc/resolv.conf", read, 0);
    allow_path(fd, "/etc/hosts", read, 1);
    allow_path(fd, "/etc/nsswitch.conf", read, 1);
    allow_path(fd, "/etc/localtime", read, 1);
    allow_path(fd, "/dev/urandom", read, 1);
    allow_path(fd, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
    /* Caller supplies a validated, reserved per-job budget. Keep the existing
     * default for other integrations and reject malformed/unbounded overrides. */
    rlim_t max_file_bytes = 536870912;
    const char *configured = getenv("NH_CONTENT_MAX_FILE_BYTES");
    if (configured) {
        if (!*configured) fail();
        for (const char *p = configured; *p; p++) if (*p < '0' || *p > '9') fail();
        errno = 0;
        char *end;
        unsigned long long value = strtoull(configured, &end, 10);
        if (errno || *end || value < 1 || value > 17179869184ULL) fail();
        max_file_bytes = (rlim_t)value;
    }
    struct rlimit file_limit = { .rlim_cur = max_file_bytes, .rlim_max = max_file_bytes };
    if (setrlimit(RLIMIT_FSIZE, &file_limit)) fail();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
    if (syscall(SYS_landlock_restrict_self, fd, 0)) fail();
    close(fd);
    for (int number = 0; number < 3; number++) {
        if (fstat(number, &st)) fail();
        if (S_ISREG(st.st_mode) && (fcntl(number, F_GETFL) & O_ACCMODE) != O_RDONLY) fail();
    }
    if (syscall(SYS_close_range, 3U, ~0U, 0)) fail();
    restrict_syscalls();
    if (chdir(stage)) fail();
    if (clearenv() || setenv("PATH", "/usr/bin:/bin", 1) || setenv("HOME", stage, 1) ||
        setenv("TMPDIR", stage, 1) || setenv("XDG_CONFIG_HOME", stage, 1) ||
        setenv("XDG_DATA_HOME", stage, 1) || setenv("XDG_CACHE_HOME", stage, 1)) fail();
    execv(argv[2], &argv[2]);
    fail();
}
