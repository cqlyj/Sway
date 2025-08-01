import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * Helper script run by the resolver (taker) on the **destination** chain (Ethereum)
 * to lock their payout tokens in a newly created EscrowDst contract.
 *
 * After successful deployment the script appends an entry into `secretMapping.json`
 * so that the bidirectional relayer can later find the appropriate escrow when
 * the secret is revealed on Sui.
 *
 * Usage (env driven):
 *   PRIVATE_KEY          – resolver EOA private key (hex)
 *   SEPOLIA_RPC          – JSON-RPC endpoint of the destination chain
 *   ESCROW_FACTORY       – deployed EscrowFactory address
 *   TOKEN                – ERC-20 token to lock (default: Mock USDC from env)
 *   AMOUNT               – token amount **with decimals** to lock (string)
 *   SAFETY_DEPOSIT_ETH   – native ETH value to send along for safety deposit (default 0)
 *   MAKER_ETH_ADDRESS    – address that should ultimately receive the payout (maker)
 *   SECRET_FILE          – path to JSON produced by `scripts/maker.ts` (default ./generatedSecret.json)
 */

const {
  PRIVATE_KEY,
  SEPOLIA_RPC,
  ESCROW_FACTORY,
  TOKEN = process.env.FEE_TOKEN,
  AMOUNT = "1000000", // 1 USDC with 6 decimals by default
  SAFETY_DEPOSIT_ETH = "0", // in wei
  MAKER_ETH_ADDRESS = "0x0000000000000000000000000000000000000000",
  SECRET_FILE = "./generatedSecret.json",
} = process.env;

if (!PRIVATE_KEY || !SEPOLIA_RPC || !ESCROW_FACTORY) {
  console.error("Missing PRIVATE_KEY, SEPOLIA_RPC, or ESCROW_FACTORY env var");
  process.exit(1);
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. Read secret information produced on Sui side
  // ---------------------------------------------------------------------------
  if (!fs.existsSync(SECRET_FILE)) {
    console.error(`Secret JSON not found at ${SECRET_FILE}`);
    process.exit(1);
  }
  const secretInfo = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
  const secretHashKeccak: string = secretInfo.hash_keccak; // bytes32 keccak256(s)

  // ---------------------------------------------------------------------------
  // 2. Chain setup
  // ---------------------------------------------------------------------------
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC as string);
  const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);
  const factory = new ethers.Contract(
    ESCROW_FACTORY as string,
    [
      "function createDstEscrow((bytes32,bytes32,address,address,address,uint256,uint256,uint256) dstImmutables,uint256 srcCancellationTs) payable",
      "function addressOfEscrowDst((bytes32,bytes32,address,address,address,uint256,uint256,uint256) dstImmutables) view returns (address)",
    ],
    wallet
  );

  // ---------------------------------------------------------------------------
  // 3. Build immutables struct
  // ---------------------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  // Very simple timelock layout: allow immediate withdrawal, cancellation after 1 hour
  // We encode only the relative seconds; deployedAt will be added by factory.
  const withdrawal = 60; // 1 min for private withdrawal
  const publicWithdrawal = 120; // +1 min
  const cancellation = 3600; // +1 h
  // helper to encode 32-bit slot
  const slot = (val: number, index: number) =>
    BigInt(val) << (BigInt(index) * 32n);
  const timelocksU256 =
    slot(withdrawal, 4) | slot(publicWithdrawal, 5) | slot(cancellation, 6);

  const immutables = {
    orderHash: ethers.ZeroHash,
    hashlock: secretHashKeccak,
    maker: MAKER_ETH_ADDRESS,
    taker: wallet.address,
    token: TOKEN,
    amount: BigInt(AMOUNT),
    safetyDeposit: BigInt(SAFETY_DEPOSIT_ETH),
    timelocks: timelocksU256,
  } as const;

  // ---------------------------------------------------------------------------
  // 4. Compute deterministic escrow address (for logging & mapping)
  // ---------------------------------------------------------------------------
  const escrowAddress: string = await factory.addressOfEscrowDst(immutables);
  console.log("Deterministic EscrowDst address:", escrowAddress);

  // ---------------------------------------------------------------------------
  // 5. Approve token transfer & call createDstEscrow
  // ---------------------------------------------------------------------------
  if (immutables.token !== ethers.ZeroAddress) {
    const erc20 = new ethers.Contract(
      immutables.token as string,
      [
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
      ],
      wallet
    );
    const allowance: bigint = await erc20.allowance(
      wallet.address,
      ESCROW_FACTORY as string
    );
    if (allowance < immutables.amount) {
      const tx = await erc20.approve(
        ESCROW_FACTORY as string,
        immutables.amount
      );
      console.log("Waiting for approve tx", tx.hash);
      await tx.wait();
    }
  }

  const tx = await factory.createDstEscrow(immutables, now + 7200, {
    value: immutables.safetyDeposit,
    gasLimit: 1_000_000,
  });
  console.log("createDstEscrow tx sent: ", tx.hash);
  await tx.wait();
  console.log("✅ EscrowDst deployed.");

  // ---------------------------------------------------------------------------
  // 6. Persist mapping for the relayer
  // ---------------------------------------------------------------------------
  const mappingPath = path.resolve("./secretMapping.json");
  let mapping: Record<string, any> = {};
  if (fs.existsSync(mappingPath)) {
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  }
  mapping[secretHashKeccak] = {
    escrowAddress,
    immutables: {
      ...immutables,
      // Convert BigNumber -> string for JSON
      amount: immutables.amount.toString(),
      safetyDeposit: immutables.safetyDeposit.toString(),
      timelocks: timelocksU256.toString(),
    },
  };
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log("Mapping updated at", mappingPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
