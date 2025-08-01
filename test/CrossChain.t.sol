// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "forge-std/Test.sol";
import "src/Resolver.sol";

contract CrossChainTest is Test {
    Resolver resolver;

    function setUp() public {
        // fork Sepolia
        vm.createSelectFork(vm.envString("SEPOLIA_RPC"));

        // deploy mocks or use existing addresses
        resolver = new Resolver(
            /*factory*/ IEscrowFactory(address(0)),
            IOrderMixin(address(0)),
            address(this)
        );
    }

    function testHappyPath() public {
        // TODO: set up escrow, simulate secret propagation, call resolver.withdraw
        assertTrue(true);
    }
}
