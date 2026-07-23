// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IArenaResolutionVerifier {
    struct ResolutionRule {
        bytes32 primarySourceId;
        bytes32 witnessSourceId;
        bytes32 sourceEventId;
        address primarySigner;
        address witnessSigner;
        uint64 maxReportAgeSeconds;
        uint64 maxSourceTimestampSkewSeconds;
        uint64 graceSeconds;
    }

    struct ResolutionReport {
        bytes32 sourceId;
        bytes32 sourceEventId;
        uint64 observedAt;
        uint64 publishedAt;
        bool finalResult;
        uint8 normalizedOutcome;
        bytes32 rawPayloadHash;
        bytes signatureEvidence;
    }

    struct VerificationResult {
        bool validQuorum;
        uint8 normalizedOutcome;
        bytes32 primaryDigest;
        bytes32 witnessDigest;
    }

    function verify(
        address exchange,
        bytes32 marketId,
        bytes32 specHash,
        uint8 outcomeCount,
        ResolutionRule calldata rule,
        ResolutionReport calldata primary,
        ResolutionReport calldata witness
    ) external view returns (VerificationResult memory result);

    function isValidSigner(address signer, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool);

    function verifyMerkle(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool);
}
