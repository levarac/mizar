// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEAS, AttestationRequest, AttestationRequestData} from "./vendor/eas/IEAS.sol";
import {MerkleProof} from "./vendor/openzeppelin/utils/cryptography/MerkleProof.sol";
import {ECDSA} from "./vendor/openzeppelin/utils/cryptography/ECDSA.sol";

contract MizarClaim {
    error NotPoster();
    error SnapshotNotIncreasing();
    error UnknownSnapshot();
    error InvalidProof();
    error InvalidSigner();
    error AlreadyClaimed();

    event RootPosted(uint64 indexed snapshotId, bytes32 root, bytes32 manifestDigest, uint64 cutoffBlock);
    event Claimed(address indexed eventKeyAddress, address indexed recipient, uint64 snapshotId, bytes32 uid);

    struct Snapshot {
        bytes32 root;
        bytes32 manifestDigest;
        bool exists;
    }

    IEAS private immutable eas;
    bytes32 private immutable schemaUid;
    bytes32 private immutable eventId;
    address private immutable poster;
    uint64 private latestSnapshotId;
    bool private hasSnapshot;
    mapping(uint64 => Snapshot) private snapshots;
    mapping(address => bool) private spent;

    constructor(IEAS eas_, bytes32 schemaUid_, bytes32 eventId_, address poster_) {
        eas = eas_;
        schemaUid = schemaUid_;
        eventId = eventId_;
        poster = poster_;
    }

    function postRoot(uint64 snapshotId, bytes32 root, bytes32 manifestDigest, uint64 cutoffBlock) external {
        if (msg.sender != poster) revert NotPoster();
        if (hasSnapshot && snapshotId <= latestSnapshotId) revert SnapshotNotIncreasing();
        snapshots[snapshotId] = Snapshot({root: root, manifestDigest: manifestDigest, exists: true});
        latestSnapshotId = snapshotId;
        hasSnapshot = true;
        emit RootPosted(snapshotId, root, manifestDigest, cutoffBlock);
    }

    function claim(
        uint64 snapshotId,
        address eventKeyAddress,
        bytes32[] calldata proof,
        address recipient,
        bytes calldata appSignature
    ) external returns (bytes32 uid) {
        Snapshot memory snapshot = snapshots[snapshotId];
        if (!snapshot.exists) revert UnknownSnapshot();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(eventKeyAddress))));
        if (!MerkleProof.verifyCalldata(proof, snapshot.root, leaf)) revert InvalidProof();

        if (ECDSA.recover(_claimDigest(recipient), appSignature) != eventKeyAddress) revert InvalidSigner();

        if (spent[eventKeyAddress]) revert AlreadyClaimed();
        spent[eventKeyAddress] = true;

        uid = _attest(snapshotId, eventKeyAddress, recipient, snapshot.manifestDigest);
        emit Claimed(eventKeyAddress, recipient, snapshotId, uid);
    }

    function _claimDigest(address recipient) private view returns (bytes32) {
        return sha256(
            abi.encodePacked(
                bytes1(0xff), "beid/event-key-sign/v1", bytes1(0), uint8(2),
                eventId, block.chainid, address(this), recipient
            )
        );
    }

    function _attest(uint64 snapshotId, address eventKeyAddress, address recipient, bytes32 manifestDigest)
        private returns (bytes32)
    {
        return eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: abi.encode(eventId, eventKeyAddress, snapshotId, manifestDigest),
                    value: 0
                })
            })
        );
    }
}
