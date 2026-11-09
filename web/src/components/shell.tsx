"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { registry } from "@/lib/registry";
import { shortAddr } from "@/lib/format";

const wallets = [
  { match: /metamask/i, name: "MetaMask", install: "https://metamask.io/download/" },
  { match: /phantom/i, name: "Phantom", install: "https://phantom.com/download" },
  { match: /rabby/i, name: "Rabby", install: "https://rabby.io/" },
];

const links = [
  ["/", "Swap"],
  ["/pools", "Pools"],
  ["/stake", "Stake"],
  ["/m421", "M421"],
  ["/board", "Board"],
  ["/activity", "Activity"],
  ["/developers", "Agents"],
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const wrongChain = connection.isConnected && connection.chainId !== registry.chainId;

  return (
    <>
      <div className="sky" />
      <div className="stars" />
      <div className="stars slow" />
      <header className="topbar">
        <Link href="/" className="brand">
          <img src={registry.brand.coin} alt="BlazarBits" />
          <span>
            <strong>BlazarSwap</strong>
            <em>v2 · Polygon PoS</em>
          </span>
        </Link>
        <nav>
          {links.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? "on" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="wallet-slot">
          <span className="chip">{wrongChain ? "Wrong network" : "Chain 137"}</span>
          {wrongChain ? (
            <Button className="cta" onClick={() => switchChain({ chainId: 137 })} disabled={switching}>
              {switching ? "Switching…" : "Switch to Polygon"}
            </Button>
          ) : connection.isConnected && connection.address ? (
            <Button variant="outline" className="cta ghost" onClick={() => disconnect()}>
              {shortAddr(connection.address)}
            </Button>
          ) : (
            <Button className="cta" onClick={() => setOpen(true)}>
              Connect
            </Button>
          )}
        </div>
      </header>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="review">
          <DialogHeader>
            <DialogTitle>Connect a wallet</DialogTitle>
            <DialogDescription>Browser wallets found with EIP-6963. MetaMask, Phantom, and Rabby on Polygon.</DialogDescription>
          </DialogHeader>
          <div className="wallet-list">
            {wallets.map((wallet) => {
              const connector = connectors.find((item) => wallet.match.test(item.name) || wallet.match.test(item.id));
              return (
                <button
                  key={wallet.name}
                  type="button"
                  disabled={!connector || isPending}
                  onClick={() => connector && connect({ connector }, { onSuccess: () => setOpen(false) })}
                >
                  <b>{wallet.name}</b>
                  <span>{connector ? "Detected" : "Not detected"}</span>
                </button>
              );
            })}
            {connectors
              .filter((item) => !wallets.some((wallet) => wallet.match.test(item.name) || wallet.match.test(item.id)))
              .map((connector) => (
                <button
                  key={connector.uid}
                  type="button"
                  disabled={isPending}
                  onClick={() => connect({ connector }, { onSuccess: () => setOpen(false) })}
                >
                  <b>{connector.name}</b>
                  <span>Detected</span>
                </button>
              ))}
          </div>
          <p className="note">
            Install{" "}
            {wallets.map((wallet, index) => (
              <span key={wallet.name}>
                {index > 0 ? ", " : ""}
                <a href={wallet.install} target="_blank" rel="noreferrer">
                  {wallet.name}
                </a>
              </span>
            ))}{" "}
            if the browser has not announced it yet.
          </p>
          {error && <p className="warn">{error.message}</p>}
        </DialogContent>
      </Dialog>
      <main className="stage">{children}</main>
      <footer>
        <span>0.05% once on external principal · BlazarSwap-only routes pay the pool fee alone</span>
        <a href={`${registry.explorer}/address/${registry.fee.recipient}`} target="_blank" rel="noreferrer">
          Dev wallet {shortAddr(registry.fee.recipient)}
        </a>
        <span>Preview build. Every approval and transaction is refused unless writes are explicitly enabled.</span>
      </footer>
    </>
  );
}
