export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
