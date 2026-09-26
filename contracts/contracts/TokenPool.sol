// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Pool {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title TokenPool
 * @notice Uniswap-V2-style constant-product (x * y = k) pool for TOKEN <-> ETH, so users can trade instantly
 *         without waiting for an order to be filled. This contract is also the LP token.
 *
 *  - Swaps are in WHOLE LOTS only (1 lot = `lotSize` tokens), same rule as the order book:
 *      buyLots(n)  -> pay ETH, receive exactly n lots
 *      sellLots(n) -> send exactly n lots, receive ETH
 *  - Fees (always in ETH):
 *      LP fee        0.3%  stays in the pool (rewards liquidity providers)
 *      protocol fee  `protocolFeeBps` (default 2%, max 5%) goes to `feeRecipient` (project revenue)
 *  - Liquidity: anyone can add ETH + tokens at the current ratio and receive LP tokens; remove any time.
 *    The first provider sets the starting price. 1,000 wei of LP is locked forever (standard V2 safety).
 *  - Reserves are tracked internally (direct donations don't move the price).
 */
contract TokenPool {
    // ---------------- LP token (ERC-20) ----------------
    string public constant name = "PoW Pool LP";
    string public constant symbol = "POW-LP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ---------------- pool ----------------
    IERC20Pool public immutable token;
    uint256 public immutable lotSize;
    uint256 public constant LP_FEE_BPS = 30; // 0.3% to liquidity providers
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 public reserveToken;
    uint256 public reserveEth;
    address public owner;
    address public feeRecipient;
    uint256 public protocolFeeBps;
    uint256 public feesOwed; // protocol fees that could not be pushed to feeRecipient
    uint256 private constant FEE_PUSH_GAS = 100_000;

    event Swap(
        address indexed trader,
        bool isBuy,
        uint256 lots,
        uint256 ethAmount, // ETH paid (buy, incl. fee) or received (sell, after fee)
        uint256 protocolFee,
        uint256 reserveToken,
        uint256 reserveEth,
        uint256 timestamp
    );
    event LiquidityAdded(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 liquidity);
    event LiquidityRemoved(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 liquidity);
    event FeeUpdated(uint256 protocolFeeBps, address feeRecipient);
    event FeeDeferred(uint256 amount);
    event FeesWithdrawn(address to, uint256 amount);
    event OwnershipTransferred(address previousOwner, address newOwner);

    error BadParams();
    error Expired();
    error Slippage();
    error NoLiquidity();
    error InsufficientLiquidity();
    error NotOwner();
    error EthTransferFailed();
    error TokenTransferFailed();
    error Reentrancy();
    error InsufficientBalance();
    error InsufficientAllowance();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier beforeDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(address _token, uint256 _lotSize, uint256 _protocolFeeBps, address _feeRecipient) {
        if (_token == address(0) || _lotSize == 0 || _protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert BadParams();
        token = IERC20Pool(_token);
        lotSize = _lotSize;
        owner = msg.sender;
        protocolFeeBps = _protocolFeeBps;
        feeRecipient = _feeRecipient == address(0) ? msg.sender : _feeRecipient;
    }

    // ------------------------------------------------------------------
    // Quotes
    // ------------------------------------------------------------------

    /// @notice ETH needed to buy `lots` right now (pool price + LP fee + protocol fee).
    function quoteBuy(uint256 lots) public view returns (uint256 total, uint256 protocolFee) {
        uint256 out = lots * lotSize;
        if (reserveToken == 0 || out >= reserveToken) revert InsufficientLiquidity();
        uint256 ethIn = _amountIn(out, reserveEth, reserveToken);
        protocolFee = (ethIn * protocolFeeBps) / 10_000;
        total = ethIn + protocolFee;
    }

    /// @notice ETH received for selling `lots` right now (after LP fee and protocol fee).
    function quoteSell(uint256 lots) public view returns (uint256 net, uint256 protocolFee) {
        if (reserveEth == 0) revert NoLiquidity();
        uint256 gross = _amountOut(lots * lotSize, reserveToken, reserveEth);
        protocolFee = (gross * protocolFeeBps) / 10_000;
        net = gross - protocolFee;
    }

    /// @notice Spot price of one lot in wei (before fees).
    function priceOfLot() external view returns (uint256) {
        if (reserveToken == 0) return 0;
        return (reserveEth * lotSize) / reserveToken;
    }

    // ------------------------------------------------------------------
    // Swaps (whole lots)
    // ------------------------------------------------------------------

    /// @notice Buy exactly `lots` lots. Send at least quoteBuy(lots).total (use maxEth slippage); extra is refunded.
    function buyLots(uint256 lots, uint256 deadline) external payable nonReentrant beforeDeadline(deadline) {
        if (lots == 0) revert BadParams();
        (uint256 total, uint256 fee) = quoteBuy(lots);
        if (msg.value < total) revert Slippage();
        uint256 out = lots * lotSize;
        reserveEth += total - fee;
        reserveToken -= out;

        if (!token.transfer(msg.sender, out)) revert TokenTransferFailed();
        if (fee > 0) _payFee(fee);
        if (msg.value > total) _sendEth(msg.sender, msg.value - total);
        emit Swap(msg.sender, true, lots, total, fee, reserveToken, reserveEth, block.timestamp);
    }

    /// @notice Sell exactly `lots` lots for at least `minEthOut`. Requires token.approve(pool, lots * lotSize).
    function sellLots(uint256 lots, uint256 minEthOut, uint256 deadline) external nonReentrant beforeDeadline(deadline) {
        if (lots == 0) revert BadParams();
        (uint256 net, uint256 fee) = quoteSell(lots);
        if (net < minEthOut) revert Slippage();
        uint256 tokenIn = lots * lotSize;
        if (!token.transferFrom(msg.sender, address(this), tokenIn)) revert TokenTransferFailed();
        reserveToken += tokenIn;
        reserveEth -= net + fee;

        _sendEth(msg.sender, net);
        if (fee > 0) _payFee(fee);
        emit Swap(msg.sender, false, lots, net, fee, reserveToken, reserveEth, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    /**
     * @notice Add liquidity: send ETH, and up to `maxTokens` tokens are pulled at the current ratio
     *         (the first provider sets the price with exactly `maxTokens`). Requires token.approve(pool, maxTokens).
     */
    function addLiquidity(uint256 maxTokens, uint256 minLiquidity, uint256 deadline)
        external
        payable
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 liquidity)
    {
        if (msg.value == 0 || maxTokens == 0) revert BadParams();
        uint256 tokens;
        if (totalSupply == 0) {
            tokens = maxTokens;
            liquidity = _sqrt(msg.value * tokens);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            _mintLp(DEAD, MINIMUM_LIQUIDITY);
            liquidity -= MINIMUM_LIQUIDITY;
        } else {
            tokens = (msg.value * reserveToken) / reserveEth + 1; // round up in the pool's favour
            if (tokens > maxTokens) revert Slippage();
            liquidity = (msg.value * totalSupply) / reserveEth;
        }
        if (liquidity == 0 || liquidity < minLiquidity) revert Slippage();
        if (!token.transferFrom(msg.sender, address(this), tokens)) revert TokenTransferFailed();
        reserveEth += msg.value;
        reserveToken += tokens;
        _mintLp(msg.sender, liquidity);
        emit LiquidityAdded(msg.sender, msg.value, tokens, liquidity);
    }

    /// @notice Burn `liquidity` LP tokens for your share of ETH + tokens.
    function removeLiquidity(uint256 liquidity, uint256 minEth, uint256 minTokens, uint256 deadline)
        external
        nonReentrant
        beforeDeadline(deadline)
        returns (uint256 ethOut, uint256 tokensOut)
    {
        if (liquidity == 0) revert BadParams();
        ethOut = (liquidity * reserveEth) / totalSupply;
        tokensOut = (liquidity * reserveToken) / totalSupply;
        if (ethOut < minEth || tokensOut < minTokens) revert Slippage();
        _burnLp(msg.sender, liquidity);
        reserveEth -= ethOut;
        reserveToken -= tokensOut;
        if (!token.transfer(msg.sender, tokensOut)) revert TokenTransferFailed();
        _sendEth(msg.sender, ethOut);
        emit LiquidityRemoved(msg.sender, ethOut, tokensOut, liquidity);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------
    function setFee(uint256 _protocolFeeBps, address _feeRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS || _feeRecipient == address(0)) revert BadParams();
        protocolFeeBps = _protocolFeeBps;
        feeRecipient = _feeRecipient;
        emit FeeUpdated(_protocolFeeBps, _feeRecipient);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert BadParams();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Send any deferred protocol fees to feeRecipient (anyone can call).
    function withdrawFees() external nonReentrant {
        uint256 amount = feesOwed;
        feesOwed = 0;
        _sendEth(feeRecipient, amount);
        emit FeesWithdrawn(feeRecipient, amount);
    }

    // ------------------------------------------------------------------
    // LP token ERC-20
    // ------------------------------------------------------------------
    function transfer(address to, uint256 value) external returns (bool) {
        _transferLp(msg.sender, to, value);
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
        _transferLp(from, to, value);
        return true;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    /// @dev Uniswap V2 getAmountOut with the LP fee.
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * (10_000 - LP_FEE_BPS);
        return (inWithFee * reserveOut) / (reserveIn * 10_000 + inWithFee);
    }

    /// @dev Uniswap V2 getAmountIn with the LP fee (rounded up).
    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        return (reserveIn * amountOut * 10_000) / ((reserveOut - amountOut) * (10_000 - LP_FEE_BPS)) + 1;
    }

    function _mintLp(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burnLp(address from, uint256 value) internal {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _transferLp(address from, address to, uint256 value) internal {
        if (to == address(0)) revert BadParams();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _payFee(uint256 amount) internal {
        (bool ok, ) = feeRecipient.call{value: amount, gas: FEE_PUSH_GAS}("");
        if (!ok) {
            feesOwed += amount;
            emit FeeDeferred(amount);
        }
    }

    function _sendEth(address to, uint256 value) internal {
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert EthTransferFailed();
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
