import { useSyncExternalStore } from "react";
import { kernel } from "../app/machine";
export function useMachine() {
  useSyncExternalStore(
    kernel.subscribe,
    () => kernel.revision,
    () => 0,
  );
  return kernel;
}
