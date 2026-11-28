int stable_helper(int value) {
  return value + 7;
}

int transform(int value) {
  return stable_helper(value) * 3 + 1;
}

int binary_diff_entry(void) {
  return transform(5);
}
