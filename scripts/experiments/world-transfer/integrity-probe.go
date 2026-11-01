// An isolated reproduction of the pinned Wings v1.11.13 archive callback's
// read contract. This is not a live Wings test or a filesystem-containment test.
package main

import (
	"archive/tar"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/mholt/archiver/v4"
)

type result struct {
	Case     string `json:"case"`
	Accepted bool   `json:"accepted"`
	Bytes    int64  `json:"bytes"`
	Error    string `json:"error,omitempty"`
}

// Construct the ZIP explicitly so malformed fields are not repaired by a writer.
func zipFixture(method uint16, payload []byte, crc, declaredSize uint32, truncateBody bool) []byte {
	name := []byte("world/region/r.0.0.mca")
	body := bytes.Clone(payload)
	if method == 8 {
		var compressed bytes.Buffer
		w, _ := flate.NewWriter(&compressed, flate.BestSpeed)
		_, _ = w.Write(payload)
		_ = w.Close()
		body = compressed.Bytes()
	}
	if truncateBody {
		body = body[:len(body)-1]
	}
	var out bytes.Buffer
	u16 := func(v uint16) { _ = binary.Write(&out, binary.LittleEndian, v) }
	u32 := func(v uint32) { _ = binary.Write(&out, binary.LittleEndian, v) }
	u32(0x04034b50)
	u16(20)
	u16(0)
	u16(method)
	u16(0)
	u16(0)
	u32(crc)
	u32(uint32(len(body)))
	u32(declaredSize)
	u16(uint16(len(name)))
	u16(0)
	out.Write(name)
	out.Write(body)
	centralOffset := out.Len()
	u32(0x02014b50)
	u16(20)
	u16(20)
	u16(0)
	u16(method)
	u16(0)
	u16(0)
	u32(crc)
	u32(uint32(len(body)))
	u32(declaredSize)
	u16(uint16(len(name)))
	u16(0)
	u16(0)
	u16(0)
	u16(0)
	u32(0)
	u32(0)
	out.Write(name)
	centralSize := out.Len() - centralOffset
	u32(0x06054b50)
	u16(0)
	u16(0)
	u16(1)
	u16(1)
	u32(uint32(centralSize))
	u32(uint32(centralOffset))
	u16(0)
	return out.Bytes()
}

func tarFixture(payload []byte) []byte {
	var out bytes.Buffer
	w := tar.NewWriter(&out)
	_ = w.WriteHeader(&tar.Header{Name: "world/region/r.0.0.mca", Size: int64(len(payload)), Mode: 0600})
	_, _ = w.Write(payload)
	_ = w.Close()
	return out.Bytes()
}

func gzipFixture(payload []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	_, _ = w.Write(payload)
	_ = w.Close()
	return out.Bytes()
}

func probe(name, filename string, data []byte, drain bool) result {
	r := result{Case: name}
	format, input, err := archiver.Identify(filename, bytes.NewReader(data))
	if err == nil {
		extractor, ok := format.(archiver.Extractor)
		if !ok {
			panic("fixture not recognized as an archive")
		}
		err = extractor.Extract(context.Background(), input, nil, func(_ context.Context, file archiver.File) error {
			if file.IsDir() {
				return nil
			}
			reader, err := file.Open()
			if err != nil {
				return err
			}
			defer reader.Close()
			destination, err := os.CreateTemp(".", "extract-probe-")
			if err != nil {
				return err
			}
			defer os.Remove(destination.Name())
			defer destination.Close()
			// Mirrors Filesystem.Write: zero bytes skip the read altogether;
			// positive sizes use io.Copy with io.LimitReader, not io.CopyN.
			if file.Size() > 0 {
				n, copyErr := io.Copy(destination, io.LimitReader(reader, file.Size()))
				r.Bytes += n
				if copyErr != nil {
					return copyErr
				}
			}
			if drain {
				_, err = io.Copy(io.Discard, reader)
				return err
			}
			return nil
		})
	}
	r.Accepted = err == nil
	if err != nil {
		r.Error = err.Error()
	}
	return r
}

func main() {
	payload := bytes.Repeat([]byte("validated-region-payload\n"), 5000)
	crc, size := crc32.ChecksumIEEE(payload), uint32(len(payload))
	var results []result
	for _, method := range []uint16{0, 8} {
		prefix := fmt.Sprintf("zip-method-%d", method)
		cases := []struct {
			name      string
			crc, size uint32
			truncate  bool
		}{
			{"valid", crc, size, false},
			{"bad-crc", crc ^ 1, size, false},
			{"zero-crc", 0, size, false},
			{"size-short", crc, size - 1, false},
			{"size-long", crc, size + 1, false},
			{"size-zero", crc, 0, false},
			{"truncated-body", crc, size, true},
		}
		for _, c := range cases {
			data := zipFixture(method, payload, c.crc, c.size, c.truncate)
			results = append(results, probe(prefix+"/"+c.name, "world.zip", data, false))
			results = append(results, probe(prefix+"/"+c.name+"/drain-control", "world.zip", data, true))
		}
		data := zipFixture(method, payload, crc, size, false)
		results = append(results, probe(prefix+"/truncated-archive", "world.zip", data[:len(data)-10], false))
	}
	tarBytes := tarFixture(payload)
	results = append(results, probe("tar/valid", "world.tar", tarBytes, false))
	corruptTar := bytes.Clone(tarBytes)
	corruptTar[512] ^= 1
	results = append(results, probe("tar/corrupt-payload", "world.tar", corruptTar, false))
	gzBytes := gzipFixture(tarBytes)
	results = append(results, probe("tar-gzip/valid", "world.tar.gz", gzBytes, false))
	badGzip := bytes.Clone(gzBytes)
	badGzip[len(badGzip)-8] ^= 1
	results = append(results, probe("tar-gzip/bad-trailer-crc", "world.tar.gz", badGzip, false))
	results = append(results, probe("tar-gzip/truncated-trailer", "world.tar.gz", gzBytes[:len(gzBytes)-8], false))

	// Deterministic model of Wings' absent-target check followed by renameat:
	// an external writer creates an empty target after the preflight check.
	root, err := os.MkdirTemp(".", "rename-probe-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(root)
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	if err := os.Mkdir(source, 0700); err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(source, "owned-marker"), []byte("owned"), 0600); err != nil {
		panic(err)
	}
	_, absent := os.Lstat(target)
	if !os.IsNotExist(absent) {
		panic("target should start absent")
	}
	if err := os.Mkdir(target, 0700); err != nil {
		panic(err)
	}
	err = syscall.Renameat(-100, source, -100, target)
	renameResult := result{Case: "rename/target-created-after-preflight", Accepted: err == nil}
	if err != nil {
		renameResult.Error = err.Error()
	}
	results = append(results, renameResult)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(results); err != nil {
		panic(err)
	}
	// Essential regression observations: this probe must not silently suggest
	// native extraction performs full validation after a dependency change.
	if !results[2].Accepted || results[3].Accepted || !renameResult.Accepted {
		fmt.Fprintln(os.Stderr, "unexpected probe result; review upstream behavior")
		os.Exit(1)
	}
}
