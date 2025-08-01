// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "forge-std/Test.sol";
import "cross-chain-swap/contracts/EscrowSrc.sol";
import "cross-chain-swap/contracts/interfaces/IBaseEscrow.sol";
import "cross-chain-swap/contracts/libraries/TimelocksLib.sol";
import "solidity-utils/contracts/libraries/AddressLib.sol";
import "openzeppelin-contracts/contracts/proxy/Clones.sol";
import "cross-chain-swap/contracts/libraries/ImmutablesLib.sol";
import "src/MockUSDC.sol";

/// @title Simple unit-test proving EscrowSrc withdraw path using a pre-defined secret.
contract EscrowSrcTest is Test {
    EscrowSrc private escrowImpl;
    EscrowSrc private escrow;
    MockUSDC private token;
    address private maker = address(0xCAFE);
    address private taker = address(0xBEEF);

    // 32-byte secret & its keccak256 hash
    bytes32 private constant SECRET =
        hex"11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff";
    bytes32 private constant SECRET_HASH = keccak256(abi.encodePacked(SECRET));

    function setUp() public {
        // 1. Deploy token and distribute to maker
        token = new MockUSDC(1_000_000 * 1e6);
        token.transfer(maker, 100_000 * 1e6);

        // 2. Deploy EscrowSrc IMPLEMENTATION (logic contract)
        escrowImpl = new EscrowSrc(3600, IERC20(address(0)));

        // 3. Build immutables & clone deterministically (mimic factory)
        IBaseEscrow.Immutables memory immutables;
        immutables.orderHash = bytes32(0);
        immutables.hashlock = SECRET_HASH;
        immutables.maker = Address.wrap(uint160(maker));
        immutables.taker = Address.wrap(uint160(taker));
        immutables.token = Address.wrap(uint160(address(token)));
        immutables.amount = 1_000 * 1e6;
        immutables.safetyDeposit = 0;

        uint256 encoded;
        encoded |=
            uint256(0) <<
            (uint256(TimelocksLib.Stage.SrcWithdrawal) * 32);
        encoded |=
            uint256(1 days) <<
            (uint256(TimelocksLib.Stage.SrcCancellation) * 32);
        Timelocks timelocks = Timelocks.wrap(encoded);
        timelocks = TimelocksLib.setDeployedAt(timelocks, block.timestamp);
        immutables.timelocks = timelocks;

        bytes32 salt = ImmutablesLib.hashMem(immutables);
        address cloneAddr = Clones.cloneDeterministic(
            address(escrowImpl),
            salt
        );
        escrow = EscrowSrc(payable(cloneAddr));

        // 4. Maker deposits tokens into clone
        vm.startPrank(maker);
        token.transfer(cloneAddr, 1_000 * 1e6);
        vm.stopPrank();
    }

    function testWithdraw() public {
        // Build Immutables struct matching escrow details
        IBaseEscrow.Immutables memory immutables;
        immutables.orderHash = bytes32(0);
        immutables.hashlock = SECRET_HASH;
        immutables.maker = Address.wrap(uint160(maker));
        immutables.taker = Address.wrap(uint160(taker));
        immutables.token = Address.wrap(uint160(address(token)));
        immutables.amount = 1_000 * 1e6;
        immutables.safetyDeposit = 0;

        // Encode timelocks: withdrawal=0, cancellation=1 day
        uint256 encoded;
        encoded |=
            uint256(0) <<
            (uint256(TimelocksLib.Stage.SrcWithdrawal) * 32);
        encoded |=
            uint256(1 days) <<
            (uint256(TimelocksLib.Stage.SrcCancellation) * 32);
        immutables.timelocks = TimelocksLib.setDeployedAt(
            Timelocks.wrap(encoded),
            block.timestamp
        );

        // Warp 1 second so withdrawal period active
        vm.warp(block.timestamp + 1);

        vm.prank(taker);
        escrow.withdraw(SECRET, immutables);

        // Verify taker received tokens
        assertEq(token.balanceOf(taker), 1_000 * 1e6);
    }
}
