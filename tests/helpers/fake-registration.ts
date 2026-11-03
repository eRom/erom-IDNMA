import type { Registration } from "../../src/bus/register.ts";

/** Inscription factice : seuls `setStatus` et `unregister` servent aux livreurs ; les appels sont enregistrés. */
export function fakeRegistration(): Registration & { statuses: string[]; unregistered: number } {
  const statuses: string[] = [];
  const fake = {
    statuses,
    unregistered: 0,
    socketPath: "/tmp/unused.sock",
    address: "uds:/tmp/unused.sock",
    entry: {},
    peerToken: "unused",
    unregister() {
      fake.unregistered++;
    },
    setStatus(status: "idle" | "busy") {
      statuses.push(status);
    },
  };
  return fake as unknown as Registration & { statuses: string[]; unregistered: number };
}
