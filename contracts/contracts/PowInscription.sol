// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title PowInscription
 * @notice Bitcoin-style Proof-of-Work mint for an inscription token on Robinhood Chain.
 *         Anyone with a CPU/GPU/phone can mine.
 *
 *  How it works:
 *   1. Contract publishes a `challenge` (like Bitcoin's previous-block hash) and a `target`.
 *   2. Miner searches off-chain for a `nonce` such that
 *          keccak256(abi.encodePacked(challenge, minerWallet, nonce)) <= target
 *      (minerWallet = the connected wallet that will claim -> nobody can steal the solution).
 *   3. First miner to claim a valid nonce for the current challenge wins the block:
 *      BLOCK_REWARD tokens go straight into the claiming wallet + an inscription event is emitted.
 *   4. A new challenge starts and the difficulty adjusts EVERY block so that blocks come
 *      ~TARGET_BLOCK_TIME apart (fast blocks -> up to 25% harder per block).
 *
 *  Supply: 21,000,000 / 5,000 per block = 4,200 blocks.
 *  Same wallet can win any number of blocks - one block per solved challenge.
 */
contract PowInscription {
    // ------------------------------------------------------------------
    // ERC-20 (minimal, self-contained)
    // ------------------------------------------------------------------
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ------------------------------------------------------------------
    // PoW parameters
    // ------------------------------------------------------------------
    uint256 public constant MAX_SUPPLY = 21_000_000 ether;
    uint256 public constant BLOCK_REWARD = 5_000 ether; // tokens per mined block
    uint256 public constant TARGET_BLOCK_TIME = 120; // seconds (2 min per block)
    uint256 public constant MIN_TARGET = 2 ** 16; // hardest possible difficulty (240 zero bits)
    uint256 public constant STALL_PERIOD = TARGET_BLOCK_TIME * 10; // no block for this long => difficulty eases

    /// @notice Easiest allowed target (minimum difficulty). Set at deploy.
    uint256 public immutable maxTarget;

    // ------------------------------------------------------------------
    // Mining state
    // ------------------------------------------------------------------
    bytes32 public challenge; // current puzzle
    uint256 public miningTarget; // stored target (lower = harder)
    uint256 public height; // number of blocks mined so far
    uint256 public lastBlockTime; // timestamp of last mined block

    mapping(address => uint256) public blocksMinedBy;

    event BlockMined(
        uint256 indexed height,
        address indexed miner,
        uint256 reward,
        bytes32 digest,
        uint256 requiredBits,
        uint256 achievedBits
    );
    /// @notice Inscription-style record of every mint (indexers can read the JSON directly).
    event Inscribed(uint256 indexed height, address indexed miner, string inscription);
    event Retarget(uint256 indexed height, uint256 oldTarget, uint256 newTarget, uint256 blockSeconds);

    error StaleChallenge(bytes32 submitted, bytes32 current);
    error InsufficientWork(bytes32 digest, uint256 target);
    error SupplyExhausted();
    error InvalidTarget();
    error InsufficientAllowance();
    error InsufficientBalance();
    error ZeroAddress();

    constructor(string memory _name, string memory _symbol, uint256 _maxTarget, uint256 _initialTarget) {
        if (_maxTarget < MIN_TARGET || _initialTarget < MIN_TARGET || _initialTarget > _maxTarget) {
            revert InvalidTarget();
        }
        name = _name;
        symbol = _symbol;
        maxTarget = _maxTarget;
        miningTarget = _initialTarget;
        challenge = keccak256(abi.encodePacked(block.chainid, address(this), blockhash(block.number - 1)));
        lastBlockTime = block.timestamp;
    }

    // ------------------------------------------------------------------
    // Mining
    // ------------------------------------------------------------------

    /**
     * @notice Claim a mined block. Tokens go directly to the wallet that sends this tx
     *         (the same wallet whose address was used while mining).
     * @param nonce             nonce found by the miner
     * @param expectedChallenge the challenge the miner worked on (cheap revert if someone already won)
     */
    function mint(uint256 nonce, bytes32 expectedChallenge) external returns (uint256 reward) {
        bytes32 current = challenge;
        if (expectedChallenge != current) revert StaleChallenge(expectedChallenge, current);

        bytes32 digest = keccak256(abi.encodePacked(current, msg.sender, nonce));
        uint256 t = currentTarget();
        if (uint256(digest) > t) revert InsufficientWork(digest, t);

        uint256 remaining = MAX_SUPPLY - totalSupply;
        if (remaining == 0) revert SupplyExhausted();
        reward = BLOCK_REWARD < remaining ? BLOCK_REWARD : remaining;

        uint256 minedHeight = height;
        _mint(msg.sender, reward);
        blocksMinedBy[msg.sender] += 1;

        emit BlockMined(minedHeight, msg.sender, reward, digest, _leadingZeroBits(t), _leadingZeroBits(uint256(digest)));
        emit Inscribed(minedHeight, msg.sender, _inscription(minedHeight, reward));

        _advance(digest, t);
    }

    /// @notice Target right now. If nobody mined for a long time, difficulty halves every STALL_PERIOD.
    function currentTarget() public view returns (uint256) {
        uint256 idle = block.timestamp - lastBlockTime;
        if (idle < STALL_PERIOD) return miningTarget;
        uint256 steps = idle / STALL_PERIOD;
        if (steps > 16) steps = 16;
        uint256 eased = miningTarget << steps;
        // overflow guard: shifting may wrap / exceed max
        if (eased > maxTarget || (eased >> steps) != miningTarget) return maxTarget;
        return eased;
    }

    /// @notice Reward for the next block (5,000 until supply runs out).
    function blockReward() public view returns (uint256) {
        uint256 remaining = MAX_SUPPLY - totalSupply;
        return BLOCK_REWARD < remaining ? BLOCK_REWARD : remaining;
    }

    /// @notice What would this nonce give `miner` right now? (0 if invalid). Used by UIs.
    function previewReward(address miner, uint256 nonce) external view returns (uint256 reward, bytes32 digest, bool valid) {
        digest = keccak256(abi.encodePacked(challenge, miner, nonce));
        valid = uint256(digest) <= currentTarget();
        if (valid) reward = blockReward();
    }

    /// @notice Everything a miner needs in one RPC call.
    function getMiningInfo()
        external
        view
        returns (
            bytes32 _challenge,
            uint256 _target,
            uint256 _height,
            uint256 _reward,
            uint256 _requiredBits,
            uint256 _difficulty,
            uint256 _totalSupply,
            uint256 _lastBlockTime
        )
    {
        _target = currentTarget();
        return (
            challenge,
            _target,
            height,
            blockReward(),
            _leadingZeroBits(_target),
            maxTarget / _target,
            totalSupply,
            lastBlockTime
        );
    }

    // ------------------------------------------------------------------
    // ERC-20
    // ------------------------------------------------------------------
    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Per-block difficulty adjustment (dampened):
     *   newTarget = oldTarget * (3T + elapsed) / 4T,  elapsed clamped to [0, 5T]
     *   instant block -> 25% harder; exactly T -> unchanged; very slow (>=5T) -> 2x easier.
     */
    function _advance(bytes32 digest, uint256 usedTarget) internal {
        uint256 elapsed = block.timestamp - lastBlockTime;
        height += 1;
        challenge = keccak256(abi.encodePacked(challenge, digest, blockhash(block.number - 1), height));
        lastBlockTime = block.timestamp;

        uint256 T = TARGET_BLOCK_TIME;
        if (elapsed > 5 * T) elapsed = 5 * T;
        uint256 oldTarget = usedTarget; // includes stall easing, if any
        uint256 newTarget = (oldTarget / (4 * T)) * (3 * T + elapsed); // divide first: no overflow
        if (newTarget < MIN_TARGET) newTarget = MIN_TARGET;
        if (newTarget > maxTarget) newTarget = maxTarget;
        miningTarget = newTarget;
        emit Retarget(height, oldTarget, newTarget, elapsed);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /// @dev data:,{"p":"prc-20","op":"mint","tick":"<SYMBOL>","blk":"<h>","amt":"<whole tokens>"}
    function _inscription(uint256 h, uint256 amount) internal view returns (string memory) {
        return string.concat(
            'data:,{"p":"prc-20","op":"mint","tick":"',
            symbol,
            '","blk":"',
            _toString(h),
            '","amt":"',
            _toString(amount / 1e18),
            '"}'
        );
    }

    function _leadingZeroBits(uint256 x) internal pure returns (uint256 n) {
        if (x == 0) return 256;
        if (x >> 128 == 0) { n += 128; x <<= 128; }
        if (x >> 192 == 0) { n += 64; x <<= 64; }
        if (x >> 224 == 0) { n += 32; x <<= 32; }
        if (x >> 240 == 0) { n += 16; x <<= 16; }
        if (x >> 248 == 0) { n += 8; x <<= 8; }
        if (x >> 252 == 0) { n += 4; x <<= 4; }
        if (x >> 254 == 0) { n += 2; x <<= 2; }
        if (x >> 255 == 0) { n += 1; }
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
