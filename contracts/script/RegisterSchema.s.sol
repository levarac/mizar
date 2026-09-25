// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISchemaRegistry} from "../src/vendor/eas/ISchemaRegistry.sol";
import {ISchemaResolver} from "../src/vendor/eas/resolver/ISchemaResolver.sol";

interface RegisterSchemaVm {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract RegisterSchema {
    RegisterSchemaVm private constant vm = RegisterSchemaVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string private constant SCHEMA = "bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest";

    function run() external returns (bytes32 uid) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        ISchemaRegistry registry = ISchemaRegistry(vm.envAddress("SCHEMA_REGISTRY_ADDRESS"));
        vm.startBroadcast(deployerPrivateKey);
        uid = registry.register(SCHEMA, ISchemaResolver(address(0)), false);
        vm.stopBroadcast();
    }
}
