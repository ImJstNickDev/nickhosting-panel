/**
 * JASSUB is used in manual canvas mode: Motion supplies native frame timestamps
 * and its own requestAnimationFrame fallback. No global video prototype patch
 * is needed. Exclude JASSUB's GPL-3.0 rvfc-polyfill from both dev and release
 * bundles; this original empty adapter contains no upstream polyfill code.
 */
export {};
