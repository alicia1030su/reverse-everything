int stable_helper(int value) {
  return value + 7;
}

int added_helper(int value) {
  return value - 2;
}

int transform(int value) {
  return stable_helper(value) * 5 + added_helper(value);
}

int binary_diff_entry(void) {
  return transform(5);
}
