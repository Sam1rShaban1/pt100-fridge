// Host tests for firmware/src/sha256.cpp.
//
// The OTA image is trusted only after this digest matches the manifest, so it
// is tested against published vectors and against every possible chunk split
// (the device feeds it 1 KiB network chunks, but short final reads happen).
#include "../src/sha256.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    checks++;                                                             \
    if (!(cond)) {                                                        \
      failures++;                                                         \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                     \
  } while (0)

static void digestOf(const uint8_t* data, size_t len, uint8_t out[32]) {
  Sha256 s;
  s.begin();
  s.update(data, len);
  s.finish(out);
}

static void expectHex(const uint8_t* data, size_t len, const char* want) {
  uint8_t d[32];
  char hex[65];
  digestOf(data, len, d);
  Sha256::hex(d, hex);
  if (strcmp(hex, want) != 0) {
    failures++;
    printf("FAIL digest len=%zu\n  got  %s\n  want %s\n", len, hex, want);
  }
  checks++;
}

static void test_vectors() {
  expectHex((const uint8_t*)"", 0,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expectHex((const uint8_t*)"abc", 3,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expectHex((const uint8_t*)"The quick brown fox jumps over the lazy dog", 43,
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");

  // Exactly one block, and one byte more (padding edge cases).
  uint8_t block[65];
  memset(block, 'a', sizeof(block));
  expectHex(block, 55,
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
  expectHex(block, 56,
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
  expectHex(block, 64,
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
  expectHex(block, 65,
            "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0");
}

static void test_chunking() {
  uint8_t buf[257];
  for (size_t i = 0; i < sizeof(buf); i++) buf[i] = (uint8_t)(i * 7 + 3);

  uint8_t whole[32];
  char want[65];
  digestOf(buf, sizeof(buf), whole);
  Sha256::hex(whole, want);

  for (size_t chunk = 1; chunk <= sizeof(buf); chunk++) {
    Sha256 s;
    s.begin();
    for (size_t off = 0; off < sizeof(buf); off += chunk) {
      size_t n = chunk < (sizeof(buf) - off) ? chunk : (sizeof(buf) - off);
      s.update(buf + off, n);
    }
    uint8_t got[32];
    char hex[65];
    s.finish(got);
    Sha256::hex(got, hex);
    if (strcmp(hex, want) != 0) {
      failures++;
      printf("FAIL chunk size %zu\n  got  %s\n  want %s\n", chunk, hex, want);
    }
    checks++;
  }
}

static void test_reuse() {
  Sha256 s;
  uint8_t a[32], b[32];
  char ha[65], hb[65];
  s.begin();
  s.update((const uint8_t*)"abc", 3);
  s.finish(a);
  Sha256::hex(a, ha);

  s.begin();
  s.update((const uint8_t*)"abc", 3);
  s.finish(b);
  Sha256::hex(b, hb);
  CHECK(strcmp(ha, hb) == 0);
  CHECK(strcmp(ha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0);
}

int main() {
  test_vectors();
  test_chunking();
  test_reuse();
  if (failures) {
    printf("%d/%d sha256 checks FAILED\n", failures, checks);
    return 1;
  }
  printf("sha256: %d checks passed\n", checks);
  return 0;
}
