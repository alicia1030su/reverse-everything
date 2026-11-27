#include <stdint.h>
#include <stdio.h>

static volatile uint32_t target_marker;

__attribute__((noinline)) void mark_target(uint64_t value) {
  target_marker = (uint32_t)value ^ 0x5a5a5a5au;
}

int main(void) {
  uint8_t bytes[8];
  if (fread(bytes, 1, sizeof(bytes), stdin) != sizeof(bytes)) {
    puts("SHORT_INPUT");
    return 2;
  }
  uint64_t value = 0;
  for (unsigned int index = 0; index < sizeof(bytes); ++index) {
    value |= (uint64_t)bytes[index] << (index * 8);
  }
  if ((value & 0xfu) != 7u) {
    puts("REJECT_NIBBLE");
    return 1;
  }
  if (value <= 0x1000u) {
    puts("REJECT_SMALL");
    return 3;
  }
  if (value == 0x1337u && ((value * 3u + 7u) & 0xffu) == 0xc6u) {
    mark_target(value);
    printf("TARGET:0x%lx\n", (unsigned long)value);
    return 0;
  }
  puts("REJECT_VALUE");
  return 4;
}
