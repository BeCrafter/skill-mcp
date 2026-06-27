/** L2-normalize a numeric array into a Float32Array (sum of squares = 1). */
export function l2Normalize(values: number[]): Float32Array {
  const vec = new Float32Array(values);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
