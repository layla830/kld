const ENCODER = new TextEncoder();

export function constantTimeEqual(value: string, expected: string): boolean {
  const valueBytes = ENCODER.encode(value);
  const expectedBytes = ENCODER.encode(expected);
  const maxLength = Math.max(valueBytes.length, expectedBytes.length);
  let diff = valueBytes.length ^ expectedBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (valueBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return diff === 0;
}
