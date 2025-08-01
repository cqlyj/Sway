// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "forge-std/Script.sol";
import "src/MockUSDC.sol";

/// @dev Deploy mock USDC token and optionally mint to additional addresses.
contract DeployMockUSDC is Script {
    function run() external {
        vm.startBroadcast();

        uint256 supply = vm.envUint("USDC_SUPPLY"); // e.g., 1000000 * 1e6
        MockUSDC usdc = new MockUSDC(supply);

        console2.log("MockUSDC deployed at", address(usdc));

        vm.stopBroadcast();
    }
}
