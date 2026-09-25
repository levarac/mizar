// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MizarClaim} from "../src/MizarClaim.sol";
import {IEAS, AttestationRequest, AttestationRequestData} from "../src/vendor/eas/IEAS.sol";
import {Attestation} from "../src/vendor/eas/Common.sol";
import {ISchemaRegistry} from "../src/vendor/eas/ISchemaRegistry.sol";
import {ISchemaResolver} from "../src/vendor/eas/resolver/ISchemaResolver.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata code) external;
    function readFile(string calldata path) external returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function skip(bool condition) external;
}

contract MockEAS {
    bytes32 public uid = keccak256("mock-attestation");
    uint256 public calls;
    bytes32 public schema;
    address public recipient;
    uint64 public expirationTime;
    bool public revocable;
    bytes32 public refUID;
    bytes public data;
    uint256 public value;

    function attest(AttestationRequest calldata request) external payable returns (bytes32) {
        calls++;
        schema = request.schema;
        recipient = request.data.recipient;
        expirationTime = request.data.expirationTime;
        revocable = request.data.revocable;
        refUID = request.data.refUID;
        data = request.data.data;
        value = request.data.value;
        return uid;
    }
}

contract MizarClaimTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 internal constant EVENT_ID = keccak256("test-event");
    bytes32 internal constant SCHEMA_UID = keccak256("test-schema");
    bytes32 internal constant MANIFEST = keccak256("test-manifest");
    address internal constant POSTER = address(0xB055);
    address internal constant RECIPIENT = address(0xCA1);

    MizarClaim internal claimContract;
    MockEAS internal mockEAS;
    address internal eventKey;

    function setUp() public {
        vm.chainId(11155111);
        eventKey = vm.addr(KEY);
        mockEAS = new MockEAS();
        claimContract = new MizarClaim(IEAS(address(mockEAS)), SCHEMA_UID, EVENT_ID, POSTER);
    }

    function testValidClaimAttestsRecipientAndData() public {
        _postLeaf(1, eventKey);
        bytes32 uid = claimContract.claim(
            1, eventKey, _emptyProof(), RECIPIENT, _signature(KEY, block.chainid, address(claimContract), RECIPIENT)
        );
        require(uid == mockEAS.uid(), "wrong UID");
        require(mockEAS.calls() == 1, "missing attestation");
        require(mockEAS.schema() == SCHEMA_UID, "wrong schema");
        require(mockEAS.recipient() == RECIPIENT, "wrong recipient");
        require(mockEAS.expirationTime() == 0 && !mockEAS.revocable(), "wrong revocation settings");
        require(mockEAS.refUID() == bytes32(0) && mockEAS.value() == 0, "wrong EAS references/value");
        require(
            keccak256(mockEAS.data()) == keccak256(abi.encode(EVENT_ID, eventKey, uint64(1), MANIFEST)), "wrong data"
        );
    }

    function testValidClaimWithSiblingProof() public {
        address otherKey = vm.addr(OTHER_KEY);
        bytes32 ownLeaf = _leaf(eventKey);
        bytes32 siblingLeaf = _leaf(otherKey);
        bytes32 root = ownLeaf < siblingLeaf
            ? keccak256(abi.encodePacked(ownLeaf, siblingLeaf))
            : keccak256(abi.encodePacked(siblingLeaf, ownLeaf));
        vm.prank(POSTER);
        claimContract.postRoot(1, root, MANIFEST, 100);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = siblingLeaf;
        claimContract.claim(
            1, eventKey, proof, RECIPIENT, _signature(KEY, block.chainid, address(claimContract), RECIPIENT)
        );
        require(mockEAS.calls() == 1, "sibling proof not accepted");
    }

    function testWrongRecipientReverts() public {
        _postLeaf(1, eventKey);
        bytes memory signature = _signature(KEY, block.chainid, address(claimContract), address(0xBAD));
        vm.expectRevert(MizarClaim.InvalidSigner.selector);
        claimContract.claim(1, eventKey, _emptyProof(), RECIPIENT, signature);
    }

    function testWrongChainReverts() public {
        _postLeaf(1, eventKey);
        bytes memory signature = _signature(KEY, 1, address(claimContract), RECIPIENT);
        vm.expectRevert(MizarClaim.InvalidSigner.selector);
        claimContract.claim(1, eventKey, _emptyProof(), RECIPIENT, signature);
    }

    function testWrongContractReverts() public {
        _postLeaf(1, eventKey);
        bytes memory signature = _signature(KEY, block.chainid, address(0xBAD), RECIPIENT);
        vm.expectRevert(MizarClaim.InvalidSigner.selector);
        claimContract.claim(1, eventKey, _emptyProof(), RECIPIENT, signature);
    }

    function testBadProofReverts() public {
        _postLeaf(1, eventKey);
        address otherKey = vm.addr(OTHER_KEY);
        bytes memory signature = _signature(OTHER_KEY, block.chainid, address(claimContract), RECIPIENT);
        vm.expectRevert(MizarClaim.InvalidProof.selector);
        claimContract.claim(1, otherKey, _emptyProof(), RECIPIENT, signature);
    }

    function testSecondClaimRevertsAcrossSnapshots() public {
        _postLeaf(1, eventKey);
        claimContract.claim(
            1, eventKey, _emptyProof(), RECIPIENT, _signature(KEY, block.chainid, address(claimContract), RECIPIENT)
        );
        _postLeaf(2, eventKey);
        bytes memory signature = _signature(KEY, block.chainid, address(claimContract), RECIPIENT);
        vm.expectRevert(MizarClaim.AlreadyClaimed.selector);
        claimContract.claim(2, eventKey, _emptyProof(), RECIPIENT, signature);
        require(mockEAS.calls() == 1, "duplicate attestation");
    }

    function testUnknownSnapshotReverts() public {
        bytes memory signature = _signature(KEY, block.chainid, address(claimContract), RECIPIENT);
        vm.expectRevert(MizarClaim.UnknownSnapshot.selector);
        claimContract.claim(1, eventKey, _emptyProof(), RECIPIENT, signature);
    }

    function testNonPosterCannotPostRoot() public {
        vm.expectRevert(MizarClaim.NotPoster.selector);
        claimContract.postRoot(1, _leaf(eventKey), MANIFEST, 100);
    }

    function testSnapshotIdsMustIncrease() public {
        _postLeaf(2, eventKey);
        vm.prank(POSTER);
        vm.expectRevert(MizarClaim.SnapshotNotIncreasing.selector);
        claimContract.postRoot(2, _leaf(eventKey), MANIFEST, 101);
    }

    function testHighSSignatureReverts() public {
        _postLeaf(1, eventKey);
        bytes32 digest = _digest(EVENT_ID, block.chainid, address(claimContract), RECIPIENT);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        bytes memory highS = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), uint8(v == 27 ? 28 : 27));
        vm.expectRevert();
        claimContract.claim(1, eventKey, _emptyProof(), RECIPIENT, highS);
    }

    function testGoldenVectorDigestAndClaim() public {
        string memory json = vm.readFile("../docs/design/test-vectors/app-signature-v1.json");
        bytes32 vectorEventId = vm.parseJsonBytes32(json, ".eventId");
        address vectorContractAddress = vm.parseJsonAddress(json, ".claim.claimContract");
        address vectorRecipient = vm.parseJsonAddress(json, ".claim.recipient");
        address vectorKey = vm.parseJsonAddress(json, ".eventKeyAddress");
        bytes32 vectorDigest = vm.parseJsonBytes32(json, ".claim.digest");
        bytes memory vectorSignature = vm.parseJsonBytes(json, ".claim.signature");
        require(
            _digest(vectorEventId, 11155111, vectorContractAddress, vectorRecipient) == vectorDigest,
            "golden digest mismatch"
        );

        MizarClaim implementation = new MizarClaim(IEAS(address(mockEAS)), SCHEMA_UID, vectorEventId, POSTER);
        vm.etch(vectorContractAddress, address(implementation).code);
        MizarClaim vectorContract = MizarClaim(vectorContractAddress);
        vm.prank(POSTER);
        vectorContract.postRoot(1, _leaf(vectorKey), MANIFEST, 100);
        vectorContract.claim(1, vectorKey, _emptyProof(), vectorRecipient, vectorSignature);
        require(mockEAS.recipient() == vectorRecipient, "golden recipient mismatch");
    }

    function testSepoliaEASFork() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        IEAS eas = IEAS(0xC2679fBD37d54388Ce493F1DB75320D236e1815e);
        ISchemaRegistry registry = ISchemaRegistry(0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0);
        require(block.chainid == 11155111, "not Sepolia");
        require(address(eas).code.length > 0 && address(registry).code.length > 0, "Sepolia EAS deployment missing");
        bytes32 schema = registry.register(
            "bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest",
            ISchemaResolver(address(0)),
            false
        );
        MizarClaim forkClaim = new MizarClaim(eas, schema, EVENT_ID, POSTER);
        vm.prank(POSTER);
        forkClaim.postRoot(1, _leaf(eventKey), MANIFEST, 100);
        bytes32 uid = forkClaim.claim(
            1, eventKey, _emptyProof(), RECIPIENT, _signature(KEY, block.chainid, address(forkClaim), RECIPIENT)
        );
        Attestation memory attestation = eas.getAttestation(uid);
        require(
            attestation.recipient == RECIPIENT && attestation.attester == address(forkClaim),
            "fork EAS attestation mismatch"
        );
        require(attestation.schema == schema && !attestation.revocable, "fork EAS schema mismatch");
    }

    function _postLeaf(uint64 snapshotId, address key) internal {
        vm.prank(POSTER);
        claimContract.postRoot(snapshotId, _leaf(key), MANIFEST, 100);
    }

    function _leaf(address key) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(key))));
    }

    function _emptyProof() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _digest(bytes32 eventId, uint256 chainId, address contractAddress, address recipient)
        internal
        pure
        returns (bytes32)
    {
        return sha256(
            abi.encodePacked(
                bytes1(0xff),
                "beid/event-key-sign/v1",
                bytes1(0),
                uint8(2),
                eventId,
                chainId,
                contractAddress,
                recipient
            )
        );
    }

    function _signature(uint256 key, uint256 chainId, address contractAddress, address recipient)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(EVENT_ID, chainId, contractAddress, recipient));
        return abi.encodePacked(r, s, v);
    }
}
