import { emit } from "dango:host";

export function main(): number {
  emit(42);
  return 42;
}
