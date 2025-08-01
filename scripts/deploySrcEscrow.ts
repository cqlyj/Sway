import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * Simple helper for the **maker** on Ethereum (source chain) to deploy an EscrowSrc
 * contract without going through 1inch Limit Order Protocol. This is **only** for
 * demo / testing – production swaps SHOULD be deployed by Resolver via LOP.
 *
 * The script:
 *   1. Reads the generated secret JSON (produced on Sui side by maker.ts).
 *   2. Deploys a fresh EscrowSrc contract (constructor requires rescueDelay & accessToken).
 *   3. Transfers maker's tokens and safety-deposit ETH into the escrow.
 *   4. Stores immutables + escrow address in secretMapping.json so the relayer can
 *      track and later submit the secret via withdraw().
 *
 * ENV required:
 *   PRIVATE_KEY        – maker EOA
 *   SEPOLIA_RPC        – RPC endpoint
 *   ACCESS_TOKEN       – address of 1inch access token (can be zero for demo)
 *   TOKEN              – ERC-20 token being sold by maker (default FEE_TOKEN env)
 *   AMOUNT             – amount with decimals (string)
 *   SAFETY_DEPOSIT_ETH – native ETH deposit (wei string, default 0)
 *   RESCUE_DELAY_SRC   – uint32 seconds (default 3600)
 *   SECRET_FILE        – path to JSON produced on Sui (default ./generatedSecret.json)
 *
 */

const {
  PRIVATE_KEY,
  SEPOLIA_RPC,
  ACCESS_TOKEN = ethers.ZeroAddress,
  TOKEN = process.env.FEE_TOKEN,
  AMOUNT = "1000000", // 1 USDC (6 decimals)
  SAFETY_DEPOSIT_ETH = "0",
  RESCUE_DELAY_SRC = "3600",
  SECRET_FILE = "./generatedSecret.json",
} = process.env;

if (!PRIVATE_KEY || !SEPOLIA_RPC || !TOKEN) {
  console.error("Missing PRIVATE_KEY, SEPOLIA_RPC, or TOKEN env var");
  process.exit(1);
}

async function main() {
  // 1. Read secret info
  if (!fs.existsSync(SECRET_FILE)) {
    console.error(`Secret JSON not found at ${SECRET_FILE}`);
    process.exit(1);
  }
  const secretInfo = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
  const secretHashKeccak: string = secretInfo.hash_keccak;

  // 2. Chain setup
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC as string);
  const wallet = new ethers.Wallet(PRIVATE_KEY as string, provider);

  // 3. Load EscrowSrc artifact
  const artifactPath = path.resolve("out/EscrowSrc.sol/EscrowSrc.json");
  if (!fs.existsSync(artifactPath)) {
    console.error("EscrowSrc artifact not found – run `forge build` first");
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const EscrowSrcFactory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  const rescueDelay = Number(RESCUE_DELAY_SRC);
  const escrow = await EscrowSrcFactory.deploy(rescueDelay, ACCESS_TOKEN);
  const depTx = escrow.deploymentTransaction();
  console.log("EscrowSrc deployment tx:", depTx ? depTx.hash : "<pending>");
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("✅ EscrowSrc deployed at", escrowAddress);

  // 4. Transfer maker tokens & safety deposit
  if (TOKEN !== ethers.ZeroAddress) {
    const erc20 = new ethers.Contract(
      TOKEN as string,
      [
        "function transfer(address,uint256) returns (bool)",
        "function decimals() view returns(uint8)",
      ],
      wallet
    );
    const tx1 = await erc20.transfer(escrowAddress, BigInt(AMOUNT));
    console.log("Token transfer tx", tx1.hash);
    await tx1.wait();
  }
  // send safety deposit ETH if requested
  if (BigInt(SAFETY_DEPOSIT_ETH) > 0n) {
    const tx2 = await wallet.sendTransaction({
      to: escrowAddress,
      value: BigInt(SAFETY_DEPOSIT_ETH),
    });
    console.log("Safety deposit tx", tx2.hash);
    await tx2.wait();
  }

  // 5. Build immutables struct (for relayer later)
  const withdrawal = 60; // seconds
  const publicWithdrawal = 120;
  const cancellation = 3600;
  const publicCancellation = 7200;
  const slot = (val: number, index: number) =>
    BigInt(val) << (BigInt(index) * 32n);
  const timelocks =
    slot(withdrawal, 0) |
    slot(publicWithdrawal, 1) |
    slot(cancellation, 2) |
    slot(publicCancellation, 3);

  const immutables = {
    orderHash: ethers.ZeroHash,
    hashlock: secretHashKeccak,
    maker: wallet.address,
    taker: wallet.address, // will be overwritten by resolver address later if desired
    token: TOKEN,
    amount: BigInt(AMOUNT),
    safetyDeposit: BigInt(SAFETY_DEPOSIT_ETH),
    timelocks,
  } as const;

  // 6. Persist mapping
  const mappingPath = path.resolve("./secretMapping.json");
  let mapping: Record<string, any> = {};
  if (fs.existsSync(mappingPath))
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  const immutablesJson = {
    ...immutables,
    amount: immutables.amount.toString(),
    safetyDeposit: immutables.safetyDeposit.toString(),
    timelocks: immutables.timelocks.toString(),
  };
  mapping[secretHashKeccak] = { escrowAddress, immutables: immutablesJson };
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log("Mapping updated at", mappingPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
