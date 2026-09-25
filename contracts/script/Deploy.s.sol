// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MizarClaim} from "../src/MizarClaim.sol";
import {IEAS} from "../src/vendor/eas/IEAS.sol";

interface DeployVm {
    function envAddress(string calldata name) external returns (address);
    function envBytes32(string calldata name) external returns (bytes32);
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract Deploy {
    DeployVm private constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (MizarClaim deployed) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        IEAS eas = IEAS(vm.envAddress("EAS_ADDRESS"));
        bytes32 schemaUid = vm.envBytes32("SCHEMA_UID");
        bytes32 eventId = vm.envBytes32("EVENT_ID");
        address poster = vm.envAddress("POSTER_ADDRESS");
        vm.startBroadcast(deployerPrivateKey);
        deployed = new MizarClaim(eas, schemaUid, eventId, poster);
        vm.stopBroadcast();
    }
}
