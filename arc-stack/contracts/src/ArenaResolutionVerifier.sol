// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { IArenaResolutionVerifier } from "./IArenaResolutionVerifier.sol";

/// @notice Stateless verifier for evidence-bound AIR Arena resolution reports.
/// @dev Source identities and signers are immutable per market in ArenaExchange. Authenticated
///      but stale, non-final, skewed, or divergent evidence deterministically yields INVALID.
contract ArenaResolutionVerifier is IArenaResolutionVerifier {
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "ResolutionReport(bytes32 marketId,bytes32 specHash,bytes32 sourceId,bytes32 sourceEventId,uint64 observedAt,uint64 publishedAt,bool finalResult,uint8 normalizedOutcome,bytes32 rawPayloadHash)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("AIR Arena Arc");
    bytes32 private constant VERSION_HASH = keccak256("1");

    error InvalidResolutionRule();
    error InvalidEvidenceIdentity();
    error InvalidEvidenceSignature();

    function isValidSigner(address signer, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }

    function verifyMerkle(bytes32[] calldata proof, bytes32 root, bytes32 leaf) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function verify(
        address exchange,
        bytes32 marketId,
        bytes32 specHash,
        uint8 outcomeCount,
        ResolutionRule calldata rule,
        ResolutionReport calldata primary,
        ResolutionReport calldata witness
    ) external view returns (VerificationResult memory result) {
        if (
            exchange == address(0) || marketId == bytes32(0) || specHash == bytes32(0)
                || rule.primarySigner == address(0) || rule.witnessSigner == address(0)
                || rule.primarySigner == rule.witnessSigner || rule.primarySourceId == bytes32(0)
                || rule.witnessSourceId == bytes32(0) || rule.primarySourceId == rule.witnessSourceId
                || rule.sourceEventId == bytes32(0) || rule.maxReportAgeSeconds == 0
        ) revert InvalidResolutionRule();
        if (
            primary.sourceId != rule.primarySourceId || witness.sourceId != rule.witnessSourceId
                || primary.sourceEventId != rule.sourceEventId || witness.sourceEventId != rule.sourceEventId
                || primary.rawPayloadHash == bytes32(0) || witness.rawPayloadHash == bytes32(0)
        ) revert InvalidEvidenceIdentity();

        bytes32 domainSeparator =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, exchange));
        result.primaryDigest = _digest(domainSeparator, marketId, specHash, primary);
        result.witnessDigest = _digest(domainSeparator, marketId, specHash, witness);
        if (
            !SignatureChecker.isValidSignatureNow(
                    rule.primarySigner, result.primaryDigest, primary.signatureEvidence
                )
                || !SignatureChecker.isValidSignatureNow(
                    rule.witnessSigner, result.witnessDigest, witness.signatureEvidence
                )
        ) revert InvalidEvidenceSignature();

        bool timestampsValid = primary.observedAt <= primary.publishedAt
            && witness.observedAt <= witness.publishedAt && primary.publishedAt <= block.timestamp
            && witness.publishedAt <= block.timestamp
            && block.timestamp - primary.publishedAt <= rule.maxReportAgeSeconds
            && block.timestamp - witness.publishedAt <= rule.maxReportAgeSeconds;
        uint256 skew = primary.publishedAt > witness.publishedAt
            ? primary.publishedAt - witness.publishedAt
            : witness.publishedAt - primary.publishedAt;
        bool outcomesValid = primary.normalizedOutcome < outcomeCount
            && witness.normalizedOutcome < outcomeCount
            && primary.normalizedOutcome == witness.normalizedOutcome;

        result.validQuorum = timestampsValid && skew <= rule.maxSourceTimestampSkewSeconds
            && primary.finalResult && witness.finalResult && outcomesValid;
        result.normalizedOutcome = result.validQuorum ? primary.normalizedOutcome : 0;
    }

    function _digest(
        bytes32 domainSeparator,
        bytes32 marketId,
        bytes32 specHash,
        ResolutionReport calldata report
    ) private pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                REPORT_TYPEHASH,
                marketId,
                specHash,
                report.sourceId,
                report.sourceEventId,
                report.observedAt,
                report.publishedAt,
                report.finalResult,
                report.normalizedOutcome,
                report.rawPayloadHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
