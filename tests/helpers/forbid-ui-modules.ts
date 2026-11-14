// Preload de test : tout chargement d'un fichier sous node_modules/@opentui/ ou node_modules/@agentclientprotocol/ échoue.
// Les commandes courtes (peer, read, hook, run --help) ne doivent jamais charger l'écran ni le SDK ACP (AC-19).
// onLoad et non onResolve : sous Bun 1.4.0, onResolve ne se déclenche pas sur un nom de paquet nu.
import { plugin } from "bun";

plugin({
  name: "forbid-ui-modules",
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]@(opentui|agentclientprotocol)[\\/]/ }, (args) => {
      throw new Error(`forbidden module ${args.path}`);
    });
  },
});
