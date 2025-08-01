// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "forge-std/Test.sol";
import "cross-chain-swap/contracts/EscrowDst.sol";
import "cross-chain-swap/contracts/interfaces/IBaseEscrow.sol";
import "cross-chain-swap/contracts/libraries/TimelocksLib.sol";
import "cross-chain-swap/contracts/libraries/ImmutablesLib.sol";
import "solidity-utils/contracts/libraries/AddressLib.sol";
import "openzeppelin-contracts/contracts/proxy/Clones.sol";
import "src/MockUSDC.sol";

/// @title Unit-test for EscrowDst withdrawal path.
contract EscrowDstTest is Test {
    using AddressLib for Address;

    Timelocks private _storedTimelocks;
    EscrowDst private escrowImpl;
    EscrowDst private escrow;
    MockUSDC private token;

    address private maker = address(0xABCD);
    address private taker = address(0xDEAD); // resolver

    // 32-byte secret & its keccak256 hash
    bytes32 private constant SECRET =
        hex"cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
    bytes32 private constant SECRET_HASH = keccak256(abi.encodePacked(SECRET));

    function setUp() public {
        // 1. Deploy destination token & fund taker (who will deposit into escrow)
        token = new MockUSDC(1_000_000 * 1e6);
        token.transfer(taker, 100_000 * 1e6);

        // 2. Deploy EscrowDst implementation (logic contract)
        escrowImpl = new EscrowDst(3600, IERC20(address(0))); // rescueDelay irrelevant for test

        // 3. Build immutables struct exactly as EscrowFactory would
        IBaseEscrow.Immutables memory imm;
        imm.orderHash = bytes32(0);
        imm.hashlock = SECRET_HASH;
        imm.maker = Address.wrap(uint160(maker));
        imm.taker = Address.wrap(uint160(taker));
        imm.token = Address.wrap(uint160(address(token)));
        imm.amount = 2_000 * 1e6;
        imm.safetyDeposit = 0;

        // Encode timelocks: withdrawal=0, publicWithdrawal=0, cancellation=1 day
        uint256 encoded;
        encoded |=
            uint256(0) <<
            (uint256(TimelocksLib.Stage.DstWithdrawal) * 32);
        encoded |=
            uint256(0) <<
            (uint256(TimelocksLib.Stage.DstPublicWithdrawal) * 32);
        encoded |=
            uint256(1 days) <<
            (uint256(TimelocksLib.Stage.DstCancellation) * 32);
        Timelocks timelocks = Timelocks.wrap(encoded);
        timelocks = TimelocksLib.setDeployedAt(timelocks, block.timestamp);
        imm.timelocks = timelocks;
        _storedTimelocks = timelocks;

        // 4. Clone deterministically using salt so address matches factory expectation
        bytes32 salt = ImmutablesLib.hashMem(imm);
        address cloneAddr = Clones.cloneDeterministic(
            address(escrowImpl),
            salt
        );
        escrow = EscrowDst(payable(cloneAddr));

        // 5. Taker deposits tokens (simulate factory createDstEscrow)
        vm.startPrank(taker);
        token.transfer(cloneAddr, imm.amount);
        vm.stopPrank();
    }

    function testWithdraw() public {
        // Fast-forward into withdrawal window
        vm.warp(block.timestamp + 1);

        vm.prank(taker);
        escrow.withdraw(SECRET, _immutables());

        // Maker should receive destination tokens
        assertEq(token.balanceOf(maker), 2_000 * 1e6);
    }

    function _immutables()
        internal
        view
        returns (IBaseEscrow.Immutables memory imm)
    {
        imm.orderHash = bytes32(0);
        imm.hashlock = SECRET_HASH;
        imm.maker = Address.wrap(uint160(maker));
        imm.taker = Address.wrap(uint160(taker));
        imm.token = Address.wrap(uint160(address(token)));
        imm.amount = 2_000 * 1e6;
        imm.safetyDeposit = 0;
        imm.timelocks = _storedTimelocks;
    }
}
