// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "forge-std/Script.sol";
import "cross-chain-swap/contracts/EscrowFactory.sol";
import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// @dev Simple script that deploys EscrowFactory and prints the address.
contract DeployEscrowFactory is Script {
    function run() external {
        vm.startBroadcast();

        // Read environment variables or pass via forge script --sig
        address lop = vm.envAddress("LOP"); // Limit Order Protocol address
        address feeToken = vm.envAddress("FEE_TOKEN");
        address accessToken = vm.envAddress("ACCESS_TOKEN");
        address owner = vm.envAddress("OWNER");

        uint32 rescueDelaySrc = uint32(vm.envUint("RESCUE_DELAY_SRC"));
        uint32 rescueDelayDst = uint32(vm.envUint("RESCUE_DELAY_DST"));

        EscrowFactory factory = new EscrowFactory(
            lop,
            IERC20(feeToken),
            IERC20(accessToken),
            owner,
            rescueDelaySrc,
            rescueDelayDst
        );

        console2.log("EscrowFactory deployed at", address(factory));

        vm.stopBroadcast();
    }
}
