# Keeper Host — Ubuntu VM Setup

[scripts/keeper.ts](../scripts/keeper.ts) has to run forever, on something that
is not a laptop. This is that setup end to end, for an Ubuntu VM on Google
Compute Engine. Only §1 is GCP-specific; the rest is any Ubuntu box.

**Where this fits:** after step 3 of the launch sequence
([`deployOracle.ts`](../scripts/deployOracle.ts)). The oracle has to exist before
the keeper has anything to call. Do the whole setup below *before* deploying the
oracle, leaving only `ORACLE_ADDRESS` blank — then paste it in and start the
service the same minute. The ~24-hour cold start begins when the keeper does, and
every hour of gap is an hour added to the wait before you can announce
([§0 of the mainnet guide](../how_to_deploy_on_mainnet.md)).

## What lives on this box, and what must not

| On the VM | Never on the VM |
| --- | --- |
| A throwaway keeper key holding ~0.05 BNB | The owner key |
| `ORACLE_ADDRESS` | `BSCSCAN_API_KEY`, `LP_TOKENS`, `LP_USDT` |

`update()` is permissionless — any funded wallet can call it. So the keeper key
can do exactly one useful thing: pay gas. It holds no Xenova, cannot move the tax
receiver, cannot repoint the oracle. If the VM is compromised the loss is capped
at the BNB sitting in that one wallet.

## 1. The VM

| Setting | Value | Why |
| --- | --- | --- |
| Machine type | `e2-micro` or `e2-small` | The keeper idles at ~150 MB and makes a few HTTPS calls every 10 minutes |
| Provisioning | **Standard — not Spot** | GCP reclaims Spot VMs within 24h. A keeper that dies daily is not a keeper |
| Image | Ubuntu 22.04 or 24.04 LTS | |
| Disk | 20 GB | `node_modules` + artifacts run ~600 MB |
| Firewall | SSH only, nothing else inbound | The keeper makes outbound calls and listens on nothing |

`e2-micro` (1 GB RAM) is free tier and fine to *run* on, but too small to
**compile** on — solc gets OOM-killed. §3 has the swap fix.

## 2. Node and git

```bash
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn
node -v    # v22.x
```

Ubuntu's own `nodejs` package is v18. It works, but v22 is what this repo is
tested on.

## 3. The repo

```bash
sudo useradd --system --home-dir /opt/xenova --shell /usr/sbin/nologin keeper
sudo mkdir -p /opt/xenova && sudo chown keeper:keeper /opt/xenova
sudo -u keeper git clone <your-repo-url> /opt/xenova

cd /opt/xenova
sudo -u keeper yarn install
sudo -u keeper yarn compile
```

Two things that bite here:

- **Do not use `yarn install --production`.** Hardhat and ts-node are
  `devDependencies`, so a production install produces a box that cannot run the
  keeper at all.
- **`yarn compile` is not optional.** `artifacts/` is gitignored, and
  `getContractAt("XenovaTwapOracle")` reads the ABI from it. A fresh clone has no
  artifacts and the keeper exits immediately.

On a 1 GB VM, add swap first or the compile is killed halfway:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Swap is only needed for the compile. The running keeper never comes near it.

## 4. The keeper wallet

Generate a fresh key **on your own machine**, from the repo root so `ethers`
resolves:

```bash
node -e "const w=require('ethers').Wallet.createRandom(); console.log(w.address, w.privateKey)"
```

Fund the printed address with **~0.05 BNB**. At 144 updates a day that lasts
about 2 months at 0.05 gwei on the first-day cost of 106,400 gas per update, and
about 4 months once the buffer has wrapped and updates cost roughly half. At
3 gwei it lasts one to two days — if gas spikes, top up or expect the keeper to
run dry.

## 5. `.env` on the VM

Three lines. Nothing else belongs here.

```bash
sudo -u keeper tee /opt/xenova/.env >/dev/null <<'EOF'
DEPLOYER_PRIVATE_KEY=0x<the keeper hot wallet from §4 — NOT the owner key>
ORACLE_ADDRESS=0x<printed by deployOracle.ts>
# Optional. Blank uses https://bsc-dataseed.binance.org.
BSC_MAINNET_RPC=
EOF
sudo chmod 600 /opt/xenova/.env
```

`DEPLOYER_PRIVATE_KEY` is a misleading name on this box.
[hardhat.config.ts:15](../hardhat.config.ts#L15) signs every transaction with
whatever is in it, so here it means "the keeper's key". Putting the owner key in
this file would park the token's admin key on an internet-facing VM for no
benefit at all — the keeper does not need it.

## 6. systemd

```bash
sudo cp /opt/xenova/deploy/keeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now keeper
```

`enable` is the half that matters long-term: it is what brings the keeper back
after a reboot. `--now` just also starts it this minute.

## 7. Confirm it is alive

```bash
journalctl -u keeper -f
```

Within seconds you should see the banner:

```
network  bsc
oracle   0x…
keeper   0x…
balance  0.05 BNB
slots    1 / 146
timing   one update every 10 min, sent 3s after each is allowed; next in 412s.
```

After that, **one `updated 0x<txhash>` line every 10 minutes and silence in
between**. The keeper sleeps until each update is due and prints only the ones
it records, so quiet is healthy and a gap past 15 minutes is not.

Then do the reboot test once, now, instead of discovering it at 3am:

```bash
sudo reboot
# reconnect, then:
systemctl is-active keeper      # → active
```

## 8. Day to day

| Task | Command |
| --- | --- |
| Watch the log | `journalctl -u keeper -f` |
| Count yesterday's updates | `journalctl -u keeper --since -24h \| grep -c updated` → expect ~143 |
| Restart | `sudo systemctl restart keeper` |
| Top up gas | Send BNB to the keeper address in the banner |
| Ship a code change | `sudo -u keeper git pull && sudo -u keeper yarn install && sudo -u keeper yarn compile && sudo systemctl restart keeper` |

The unit runs with `--no-compile`, so `yarn compile` after a `git pull` is on
you. Skip it and the keeper silently keeps running the old ABI.

## 9. What this setup deliberately does not do

There is **no alerting**, matching
[§7 of the mainnet guide](../how_to_deploy_on_mainnet.md). systemd restarts a
crashed process, but the failures that actually happen are not crashes — an RPC
provider rate-limiting you, or the keeper wallet running dry — and those leave
the service reading `active` while recording nothing on chain.

So the daily [`status.ts`](../scripts/status.ts) check stays manual and needs a
named owner. The cheap upgrade, whenever you want it, is a **second keeper** on a
different provider with a different key: whichever loses the race is refused
during gas estimation and never broadcasts, so two keepers cost a second VM and a
second funded wallet — not double gas.
