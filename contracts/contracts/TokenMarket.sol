// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title TokenMarket
 * @notice Simple on-chain order book for the mined token, paid in ETH.
 *
 *  Sell side (listings):  seller escrows tokens -> anyone can buy all or part, paying ETH.
 *  Buy side (bids):       buyer escrows ETH     -> any holder can sell into it, receiving ETH.
 *
 *  - Partial fills on both sides.
 *  - Cancel any time: unfilled tokens / ETH go back.
 *  - Optional marketplace fee (basis points, max 5%) taken from the ETH side, sent to feeRecipient.
 *  - Price is always "wei per 1 whole token" (1e18 token units).
 */
contract TokenMarket {
    IERC20 public immutable token;
    address public owner;
    address public feeRecipient;
    uint256 public feeBps; // 100 = 1%
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 private constant ONE = 1e18;

    struct Order {
        address maker;
        uint128 amount; // remaining token amount (18 decimals)
        uint128 price; // wei per whole token
        bool isBid; // false = sell listing, true = buy bid
        bool active;
    }

    Order[] public orders;
    mapping(uint256 => uint256) public bidEscrow; // exact ETH still held for each bid

    event OrderCreated(uint256 indexed id, address indexed maker, bool isBid, uint256 amount, uint256 price);
    event OrderCancelled(uint256 indexed id, address indexed maker, uint256 amountLeft);
    event Trade(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 price,
        uint256 ethPaid,
        uint256 fee
    );
    event FeeUpdated(uint256 feeBps, address feeRecipient);

    error NotOwner();
    error BadParams();
    error OrderClosed();
    error NotMaker();
    error WrongSide();
    error InsufficientPayment(uint256 required, uint256 sent);
    error EthTransferFailed();
    error TokenTransferFailed();
    error Reentrancy();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address _token, uint256 _feeBps, address _feeRecipient) {
        if (_token == address(0) || _feeBps > MAX_FEE_BPS) revert BadParams();
        token = IERC20(_token);
        owner = msg.sender;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient == address(0) ? msg.sender : _feeRecipient;
    }

    // ------------------------------------------------------------------
    // Sell side
    // ------------------------------------------------------------------

    /// @notice List tokens for sale. Requires token.approve(market, amount) first.
    function list(uint256 amount, uint256 pricePerToken) external nonReentrant returns (uint256 id) {
        _checkOrder(amount, pricePerToken);
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TokenTransferFailed();
        id = _push(msg.sender, amount, pricePerToken, false);
    }

    /// @notice Buy `amount` tokens from listing `id`. Send at least quoteBuy(id, amount) ETH; extra is refunded.
    function buy(uint256 id, uint256 amount) external payable nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.isBid) revert WrongSide();
        if (amount == 0 || amount > o.amount) revert BadParams();

        uint256 cost = _cost(amount, o.price);
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);

        o.amount -= uint128(amount);
        if (o.amount == 0) o.active = false;
        address seller = o.maker;
        uint256 fee = (cost * feeBps) / 10_000;

        if (!token.transfer(msg.sender, amount)) revert TokenTransferFailed();
        _sendEth(seller, cost - fee);
        if (fee > 0) _sendEth(feeRecipient, fee);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);

        emit Trade(id, msg.sender, seller, amount, o.price, cost, fee);
    }

    // ------------------------------------------------------------------
    // Buy side
    // ------------------------------------------------------------------

    /// @notice Place a bid: escrow ETH to buy `amount` tokens at `pricePerToken`.
    function bid(uint256 amount, uint256 pricePerToken) external payable nonReentrant returns (uint256 id) {
        _checkOrder(amount, pricePerToken);
        uint256 cost = _cost(amount, pricePerToken);
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);
        id = _push(msg.sender, amount, pricePerToken, true);
        bidEscrow[id] = cost;
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Sell `amount` tokens into bid `id`. Requires token.approve(market, amount) first.
    function sell(uint256 id, uint256 amount) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (!o.isBid) revert WrongSide();
        if (amount == 0 || amount > o.amount) revert BadParams();

        // Partial fill pays floor(amount*price); the final fill takes whatever escrow is left,
        // so rounding never lets a bid pay out more ETH than it deposited.
        uint256 value = amount == o.amount ? bidEscrow[id] : (amount * o.price) / ONE;
        bidEscrow[id] -= value;
        o.amount -= uint128(amount);
        if (o.amount == 0) o.active = false;
        address buyer = o.maker;
        uint256 fee = (value * feeBps) / 10_000;

        if (!token.transferFrom(msg.sender, buyer, amount)) revert TokenTransferFailed();
        _sendEth(msg.sender, value - fee);
        if (fee > 0) _sendEth(feeRecipient, fee);

        emit Trade(id, buyer, msg.sender, amount, o.price, value, fee);
    }

    // ------------------------------------------------------------------
    // Both sides
    // ------------------------------------------------------------------

    /// @notice Cancel your order; unfilled tokens (listing) or ETH (bid) are returned.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.maker != msg.sender) revert NotMaker();
        uint256 left = o.amount;
        o.active = false;
        o.amount = 0;
        if (o.isBid) {
            uint256 refund = bidEscrow[id];
            bidEscrow[id] = 0;
            _sendEth(msg.sender, refund);
        } else if (!token.transfer(msg.sender, left)) {
            revert TokenTransferFailed();
        }
        emit OrderCancelled(id, msg.sender, left);
    }

    /// @notice ETH needed to buy `amount` from listing `id` (rounded up in seller's favour).
    function quoteBuy(uint256 id, uint256 amount) external view returns (uint256) {
        return _cost(amount, orders[id].price);
    }

    function ordersCount() external view returns (uint256) {
        return orders.length;
    }

    /// @notice Page through orders for UIs: returns orders[from .. from+count).
    function getOrders(uint256 from, uint256 count) external view returns (Order[] memory out) {
        uint256 n = orders.length;
        if (from >= n) return new Order[](0);
        uint256 end = from + count > n ? n : from + count;
        out = new Order[](end - from);
        for (uint256 i = from; i < end; i++) out[i - from] = orders[i];
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------
    function setFee(uint256 _feeBps, address _feeRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (_feeBps > MAX_FEE_BPS || _feeRecipient == address(0)) revert BadParams();
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeUpdated(_feeBps, _feeRecipient);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert BadParams();
        owner = newOwner;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    function _checkOrder(uint256 amount, uint256 price) internal pure {
        if (amount == 0 || price == 0 || amount > type(uint128).max || price > type(uint128).max) revert BadParams();
    }

    function _push(address maker, uint256 amount, uint256 price, bool isBid) internal returns (uint256 id) {
        id = orders.length;
        orders.push(Order(maker, uint128(amount), uint128(price), isBid, true));
        emit OrderCreated(id, maker, isBid, amount, price);
    }

    function _cost(uint256 amount, uint256 price) internal pure returns (uint256) {
        return (amount * price + ONE - 1) / ONE; // round up
    }

    function _sendEth(address to, uint256 value) internal {
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert EthTransferFailed();
    }
}
