import { createConfig, http } from "wagmi";
import { polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { registry } from "@/lib/registry";

const rpc = process.env.NEXT_PUBLIC_POLYGON_RPC || registry.rpc[0];

export const wagmiConfig = createConfig({
  chains: [polygon],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [polygon.id]: http(rpc),
  },
  ssr: true,
});
