/// <reference types="node" />
import { ethers } from "ethers";
import { SuiClient } from "@mysten/sui/client";
import { blake2b } from "@noble/hashes/blake2b";
import { sha3_256 } from "@noble/hashes/sha3";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load env from repository root if present
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
// Then load local scripts/.env as fallback
dotenv.config();

/**
 * Relayer script that watches for `SecretRevealed` events on the destination chain
 * (Sui) and replays the same secret on the Ethereum source escrow, or vice-versa.
 *
 * ENV required:
 *  ETH_RPC_URL           – Ethereum JSON-RPC endpoint (L1 or L2 testnet)
 *  ETH_PRIVATE_KEY       – Private key of the resolver / relayer (hex string)
 *  ESCROW_FACTORY        – Address of EscrowFactory on Ethereum
 *  SUI_RPC_URL           – Sui fullnode RPC endpoint
 *  SUI_KEY               – Base64-encoded 32-byte private key for Sui signer
 *  HASHLOCK_EVENT_FILTER – (optional) Custom filter topic for Ethereum Secret events
 */

// Prefer provided env vars but fall back to legacy names for convenience
const ETH_RPC_URL = (process.env.ETH_RPC_URL ||
  process.env.SEPOLIA_RPC ||
  "https://eth-sepolia.g.alchemy.com/v2/s-ac83IhcgQblu9D1l8WCyWDxQPWBvGh") as string;
const ETH_PRIVATE_KEY = (process.env.PRIVATE_KEY ||
  process.env.ETH_PRIVATE_KEY ||
  "0x344f59f3270a57ac589cce3a23b9f75bb665e0be31f4ed4cb238ed5e03d9318b") as string;
const ESCROW_FACTORY = (process.env.ESCROW_FACTORY ||
  "0x9aF4CD71878aF8750505BcEF0512AB9816B20e37") as string;
const SUI_RPC_URL = (process.env.SUI_RPC ||
  process.env.SUI_RPC_URL ||
  "https://fullnode.testnet.sui.io") as string;
const SUI_KEY = (process.env.SUI_KEYPAIR ||
  process.env.SUI_KEY ||
  "[189,7,171,244,140,163,167,38,177,173,149,188,83,252,161,19,167,185,120,137,53,107,226,5,154,64,165,60,2,50,122,236]") as string;

if (
  !ETH_RPC_URL ||
  !ETH_PRIVATE_KEY ||
  !ESCROW_FACTORY ||
  !SUI_RPC_URL ||
  !SUI_KEY
) {
  throw new Error(
    "Missing env vars – please define ETH_RPC_URL, ETH_PRIVATE_KEY, ESCROW_FACTORY, SUI_RPC_URL, SUI_KEY"
  );
}

/* -------------------------------------------------------------------------- */
/*                              Ethereum setup                                */
/* -------------------------------------------------------------------------- */

const ethProvider = new ethers.JsonRpcProvider(ETH_RPC_URL);
const ethWallet = new ethers.Wallet(ETH_PRIVATE_KEY, ethProvider);

// Minimal ABI containing the withdraw() function and SecretRevealed event
const escrowAbi = [
  "event SecretRevealed(bytes32 indexed secretHash, bytes secret)",
  "function withdraw(bytes32 secret, (address,address,uint256,uint256,uint256,bytes32) immutables) external",
];

/* -------------------------------------------------------------------------- */
/*                                 Sui setup                                  */
/* -------------------------------------------------------------------------- */

const suiProvider = new SuiClient({ url: SUI_RPC_URL });

/* -------------------------------------------------------------------------- */
/*                             Helper functions                               */
/* -------------------------------------------------------------------------- */

function hashSecret(secret: Uint8Array): string {
  return "0x" + Buffer.from(blake2b(secret, { dkLen: 32 })).toString("hex");
}

/* -------------------------------------------------------------------------- */
/*                              Event watching                                */
/* -------------------------------------------------------------------------- */

async function watchSuiEvents() {
  type SecretEvent = { secret: number[] };

  console.log("Listening for SecretRevealed events on Sui …");
  // NOTE: the Sui event type string must match Move struct path
  const packageId =
    process.env.FUSION_LOCKER_PACKAGE ||
    "0xfc2cd9bf4cc4135ec27dbf8e12f9ec37690c95f47a98b5406feb09aa060bcaf8";
  const eventType = `${packageId}::shared_locker::SrcSecretRevealed`;
  const unsubscribe = await suiProvider.subscribeEvent({
    filter: { MoveEventType: eventType },
    onMessage: async (event: any) => {
      try {
        const secretVec: number[] = event.parsedJson.secret; // vector<u8>
        const secret = Uint8Array.from(secretVec);
        const secretHex = "0x" + Buffer.from(secret).toString("hex");
        const secretHash = hashSecret(secret);
        console.log(`Secret revealed on Sui: ${secretHex}`);
        await submitSecretToEthereum(secretHex);
      } catch (err) {
        console.error("Failed handling Sui event", err);
      }
    },
  });

  return unsubscribe;
}

/* -------------------------------------------------------------------------- */
/*                      Sui -> Ethereum event forwarding                       */
/* -------------------------------------------------------------------------- */

import fs from "fs";

/**
 * Persistent mapping secretHash -> { escrowAddress, immutables }
 * The maker script appends entries to this JSON file so that the relayer can
 * resume after restarts.
 */
const mappingPath = path.resolve("./secretMapping.json");
let secretHashToEscrow: Record<
  string,
  { escrowAddress: string; immutables: readonly unknown[] }
> = {};
try {
  if (fs.existsSync(mappingPath)) {
    secretHashToEscrow = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  }
} catch (e) {
  console.warn("Failed to load secretMapping.json – starting with empty map");
}

function persistMapping() {
  fs.writeFileSync(mappingPath, JSON.stringify(secretHashToEscrow, null, 2));
}

async function submitSecretToEthereum(secretHex: string) {
  const secretHash = ethers.id(secretHex);
  const mapping = secretHashToEscrow[secretHash];
  if (!mapping) {
    console.warn(
      `No escrow mapping found for secret hash ${secretHash}, skipping submission …`
    );
    return;
  }

  const { escrowAddress, immutables } = mapping;
  console.log(
    `Submitting secret to Ethereum escrow ${escrowAddress} with secret ${secretHex} …`
  );

  const escrow = new ethers.Contract(escrowAddress, escrowAbi, ethWallet);
  const tx = await escrow.withdraw(secretHex, immutables);
  await tx.wait();
  console.log(`✅ withdraw() executed. Tx hash: ${tx.hash}`);
}

/* -------------------------------------------------------------------------- */
/*                      Ethereum -> Sui event forwarding                       */
/* -------------------------------------------------------------------------- */

async function watchEthereumEvents() {
  console.log("Listening for SecretRevealed events on Ethereum …");
  const secretRevealedTopic = ethers.id("SecretRevealed(bytes32,bytes)");

  ethProvider.on(
    {
      topics: [secretRevealedTopic],
    },
    async (log) => {
      try {
        const iface = new ethers.Interface(escrowAbi);
        const parsed = iface.parseLog(log)!;
        const secretHex: string = parsed.args.secret;
        console.log(`Secret revealed on Ethereum: ${secretHex}`);
        await submitSecretToSui(secretHex);
      } catch (err) {
        console.error("Failed handling Ethereum event", err);
      }
    }
  );
}

async function submitSecretToSui(secretHex: string) {
  const secretBytes = Uint8Array.from(Buffer.from(secretHex.slice(2), "hex"));
  const blake = hashSecret(secretBytes);
  const mapping: any =
    secretHashToEscrow[blake] || secretHashToEscrow[secretHex];
  if (!mapping || !mapping.lockerId) {
    console.warn(`No locker mapping found for secret hash ${blake}`);
    return;
  }
  const lockerId = mapping.lockerId;

  // Fetch current shared object version
  const lockerMeta = await suiProvider.getObject({
    id: lockerId,
    options: { showContent: false },
  });
  const initialVersion = Number(
    (lockerMeta as any).data?.owner?.Shared?.initial_shared_version ??
      (lockerMeta as any).data?.version ??
      (lockerMeta as any).version ??
      1
  );

  const tx = new (await import("@mysten/sui/transactions")).Transaction();
  tx.moveCall({
    target: `${
      process.env.FUSION_LOCKER_PACKAGE ||
      "0xfc2cd9bf4cc4135ec27dbf8e12f9ec37690c95f47a98b5406feb09aa060bcaf8"
    }::shared_locker::claim_shared`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      // supply correct shared object reference with initial version
      tx.object(lockerId),
      tx.pure.vector("u8", Array.from(secretBytes)),
      tx.pure.address(process.env.SUI_ADDRESS as string),
      tx.object("0x6"),
    ],
  });
  tx.setGasBudget(1_000_000_000);
  try {
    const kp = (
      await import("@mysten/sui/keypairs/ed25519")
    ).Ed25519Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(SUI_KEY as string))
    );

    const result = await suiProvider.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
    });
    console.log(`✅ Sui claim executed. Digest: ${result.digest}`);
  } catch (err) {
    console.error("Failed to submit secret to Sui", err);
  }
}

async function main() {
  await watchSuiEvents();
  await watchEthereumEvents();
  console.log("Relayer started. Waiting for events…");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
