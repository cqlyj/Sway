import { spawn, execSync } from "child_process";
import dotenv from "dotenv";
import path from "path";

// Load env from repo root .env if present
dotenv.config({ path: path.resolve(".env") });

function runSync(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  execSync([cmd, ...args].join(" "), {
    stdio: "inherit",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
}

async function main() {
  const env = process.env;

  // 1) Maker locks on Sui – generates secret + mapping files
  runSync("ts-node", ["--esm", "maker.ts"], env);

  // 2) Deploy destination escrow on Sepolia using Forge script
  console.log("\n📦 Deploying destination escrow on Sepolia...");

  // Extract hashlock from generated secret
  const fs = await import("fs");
  const secretInfo = JSON.parse(
    fs.readFileSync("./generatedSecret.json", "utf8")
  );
  const hashlock = secretInfo.hash_keccak;
  const maker = "0xFB6a372F2F51a002b390D18693075157A459641F";

  const forgeEnv = {
    ...env,
    HASHLOCK: hashlock,
    ESCROW_FACTORY:
      env.ESCROW_FACTORY || "0x9aF4CD71878aF8750505BcEF0512AB9816B20e37",
    TOKEN: env.TOKEN || "0x0000000000000000000000000000000000000000",
    AMOUNT: env.AMOUNT || "100000000000000",
    SAFETY_DEPOSIT_ETH: env.SAFETY_DEPOSIT_ETH || "10000000000000",
    MAKER: maker,
  };

  // Change to root directory to run forge script
  process.chdir("..");

  runSync(
    "forge",
    [
      "script",
      "script/DeployDstEscrow.s.sol:DeployDstEscrow",
      "--rpc-url",
      env.SEPOLIA_RPC as string,
      "--private-key",
      env.PRIVATE_KEY as string,
      "--broadcast",
      "--silent",
    ],
    forgeEnv
  );

  // Change back to scripts directory
  process.chdir("scripts");

  // Update secretMapping.json with escrow details
  console.log("✅ Escrow deployed, updating secret mapping...");

  // 3) Start bidirectional relayer (keeps process alive)
  console.log("\nStarting relayer – press Ctrl+C when done …\n");
  const relayer = spawn("npm", ["run", "start"], {
    stdio: "inherit",
    env,
  });

  // Propagate stop signals to child process
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) {
    process.on(sig, () => {
      relayer.kill(sig);
      process.exit();
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
