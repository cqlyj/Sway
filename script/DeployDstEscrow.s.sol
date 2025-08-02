// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IBaseEscrow} from "lib/cross-chain-swap/contracts/interfaces/IBaseEscrow.sol";
import {IEscrowFactory} from "lib/cross-chain-swap/contracts/interfaces/IEscrowFactory.sol";
import {Timelocks, TimelocksLib} from "lib/cross-chain-swap/contracts/libraries/TimelocksLib.sol";
import {Address} from "solidity-utils/contracts/libraries/AddressLib.sol";

/// @notice Minimal Forge script that builds a destination Escrow immutables struct and calls
///         EscrowFactory.createDstEscrow. All parameters are taken from environment variables so
///         the script can run on any RPC without code edits.
///
/// Required environment variables:
///   PRIVATE_KEY             – deployer private key (also taker)
///   ESCROW_FACTORY          – address of deployed EscrowFactory
///   TOKEN                   – dst token (0x0 for native ETH)
///   AMOUNT                  – dst token amount (wei)
///   SAFETY_DEPOSIT_ETH      – safety deposit in wei (may be 0)
///   HASHLOCK                – bytes32 hash of secret
///   MAKER                   – maker address (receives dst tokens)
///   WITHDRAWAL              – uint32 seconds until taker-only withdrawal
///   PUB_WITHDRAWAL          – uint32 seconds until public withdrawal (optional, default = WITHDRAWAL+60)
///   CANCELLATION            – uint32 seconds until taker cancellation (optional, default = WITHDRAWAL+3600)
contract DeployDstEscrow is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        IEscrowFactory factory = IEscrowFactory(
            vm.envAddress("ESCROW_FACTORY")
        );
        address token = vm.envAddress("TOKEN"); // 0x0 allowed by forge
        uint256 amount = vm.envUint("AMOUNT");
        uint256 safetyDeposit = vm.envUint("SAFETY_DEPOSIT_ETH");
        bytes32 hashlock = vm.envBytes32("HASHLOCK");
        address maker = vm.envAddress("MAKER");

        uint32 withdrawal = uint32(vm.envOr("WITHDRAWAL", uint256(60)));
        uint32 pubWithdrawal = uint32(
            vm.envOr("PUB_WITHDRAWAL", uint256(withdrawal + 60))
        );
        uint32 cancellation = uint32(
            vm.envOr("CANCELLATION", uint256(withdrawal + 3600))
        );

        // Encode destination timelocks in slots 4-6; source slots remain zero.
        uint256 timelocksU256 = (uint256(withdrawal) << (4 * 32)) |
            (uint256(pubWithdrawal) << (5 * 32)) |
            (uint256(cancellation) << (6 * 32));
        Timelocks timelocks = Timelocks.wrap(timelocksU256);

        IBaseEscrow.Immutables memory immutables = IBaseEscrow.Immutables({
            orderHash: bytes32(0),
            hashlock: hashlock,
            maker: Address.wrap(uint160(maker)),
            taker: Address.wrap(uint160(deployer)),
            token: Address.wrap(uint160(token)),
            amount: amount,
            safetyDeposit: safetyDeposit,
            timelocks: timelocks
        });

        // Prepare value; for native token escrow we must send amount + safetyDeposit.
        uint256 nativeValue = token == address(0)
            ? amount + safetyDeposit
            : safetyDeposit;
        uint256 srcCancellationTimestamp = block.timestamp + cancellation + 300; // give 5-min slack

        vm.startBroadcast(pk);

        // Approve ERC-20 if needed.
        if (token != address(0)) {
            IERC20(token).approve(address(factory), amount);
        }

        factory.createDstEscrow{value: nativeValue}(
            immutables,
            srcCancellationTimestamp
        );

        vm.stopBroadcast();
    }
}
