#if defined(_WIN32)
#define V004_EXPORT __declspec(dllexport)
#else
#define V004_EXPORT __attribute__((visibility("default")))
#endif

#define V004_NOINLINE __attribute__((noinline))

static const char v004_marker[] = "V004_GHIDRA_KNOWN_STRING";

V004_EXPORT V004_NOINLINE int v004_leaf(int value) {
  return value + 7;
}

V004_EXPORT V004_NOINLINE const char *v004_message(void) {
  return v004_marker;
}

V004_EXPORT V004_NOINLINE int v004_entry(int value) {
  const char *message = v004_message();
  return v004_leaf(value) + (unsigned char)message[0];
}
