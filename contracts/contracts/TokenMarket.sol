// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title TokenMarket
 * @notice On-chain order book for the mined token, traded ONLY in whole lots, paid in ETH.
 *         1 lot = `lotSize` tokens (5,000 = one mined block). No small chunks.
 *
 *  Sell side (listings):  seller escrows N lots   -> anyone can buy 1..N whole lots.
 *  Buy side (bids):       buyer escrows ETH       -> any holder can sell 1..N whole lots into it.
 *
 *  - Price is "wei per lot"; every trade costs exactly lots * pricePerLot (no rounding).
 *  - Cancel any time: unfilled lots / ETH go back.
 *  - Marketplace fee (basis points, default 2%, max 5%) taken from the ETH side, sent to feeRecipient.
 */
contract TokenMarket {
    IERC20 public immutable token;
    uint256 public immutable lotSize; // token units per lot (18 decimals)
    address public owner;
    address public feeRecipient;
    uint256 public feeBps; // 100 = 1%
    uint256 public constant MAX_FEE_BPS = 500;

    struct Order {
        address maker;
        uint64 lots; // remaining whole lots
        uint128 pricePerLot; // wei per lot
        bool isBid; // false = sell listing, true = buy bid
        bool active;
    }

    Order[] public orders;

    event OrderCreated(uint256 indexed id, address indexed maker, bool isBid, uint256 lots, uint256 pricePerLot);
    event OrderCancelled(uint256 indexed id, address indexed maker, uint256 lotsLeft);
    event Trade(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 lots,
        uint256 pricePerLot,
        uint256 ethPaid,
        uint256 fee,
        uint256 timestamp
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

    constructor(address _token, uint256 _lotSize, uint256 _feeBps, address _feeRecipient) {
        if (_token == address(0) || _lotSize == 0 || _feeBps > MAX_FEE_BPS) revert BadParams();
        token = IERC20(_token);
        lotSize = _lotSize;
        owner = msg.sender;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient == address(0) ? msg.sender : _feeRecipient;
    }

    // ------------------------------------------------------------------
    // Sell side
    // ------------------------------------------------------------------

    /// @notice List `lots` whole lots for sale. Requires token.approve(market, lots * lotSize) first.
    function list(uint256 lots, uint256 pricePerLot) external nonReentrant returns (uint256 id) {
        _checkOrder(lots, pricePerLot);
        if (!token.transferFrom(msg.sender, address(this), lots * lotSize)) revert TokenTransferFailed();
        id = _push(msg.sender, lots, pricePerLot, false);
    }

    /// @notice Buy `lots` whole lots from listing `id`. Send exactly lots * pricePerLot ETH (extra is refunded).
    function buy(uint256 id, uint256 lots) external payable nonReentrant {
        uint256 cost = _quote(id, lots);
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);
        _buy(id, lots);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Quick buy: fill several listings in one tx (e.g. the cheapest ones). Whole lots only.
    function buyMany(uint256[] calldata ids, uint256[] calldata lots) external payable nonReentrant {
        if (ids.length == 0 || ids.length != lots.length) revert BadParams();
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) total += _quote(ids[i], lots[i]);
        if (msg.value < total) revert InsufficientPayment(total, msg.value);
        for (uint256 i = 0; i < ids.length; i++) _buy(ids[i], lots[i]);
        if (msg.value > total) _sendEth(msg.sender, msg.value - total);
    }

    // ------------------------------------------------------------------
    // Buy side
    // ------------------------------------------------------------------

    /// @notice Place a bid for `lots` whole lots at `pricePerLot`; escrows lots * pricePerLot ETH.
    function bid(uint256 lots, uint256 pricePerLot) external payable nonReentrant returns (uint256 id) {
        _checkOrder(lots, pricePerLot);
        uint256 cost = lots * pricePerLot;
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);
        id = _push(msg.sender, lots, pricePerLot, true);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Sell `lots` whole lots into bid `id`. Requires token.approve(market, lots * lotSize) first.
    function sell(uint256 id, uint256 lots) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (!o.isBid) revert WrongSide();
        if (lots == 0 || lots > o.lots) revert BadParams();

        uint256 value = lots * o.pricePerLot;
        o.lots -= uint64(lots);
        if (o.lots == 0) o.active = false;
        address buyer = o.maker;
        uint256 fee = (value * feeBps) / 10_000;

        if (!token.transferFrom(msg.sender, buyer, lots * lotSize)) revert TokenTransferFailed();
        _sendEth(msg.sender, value - fee);
        if (fee > 0) _sendEth(feeRecipient, fee);

        emit Trade(id, buyer, msg.sender, lots, o.pricePerLot, value, fee, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Both sides
    // ------------------------------------------------------------------

    /// @notice Cancel your order; unfilled lots (listing) or ETH (bid) are returned.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.maker != msg.sender) revert NotMaker();
        uint256 left = o.lots;
        o.active = false;
        o.lots = 0;
        if (o.isBid) {
            _sendEth(msg.sender, left * o.pricePerLot);
        } else if (!token.transfer(msg.sender, left * lotSize)) {
            revert TokenTransferFailed();
        }
        emit OrderCancelled(id, msg.sender, left);
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
    function _checkOrder(uint256 lots, uint256 pricePerLot) internal pure {
        if (lots == 0 || pricePerLot == 0 || lots > type(uint64).max || pricePerLot > type(uint128).max) revert BadParams();
    }

    function _push(address maker, uint256 lots, uint256 pricePerLot, bool isBid) internal returns (uint256 id) {
        id = orders.length;
        orders.push(Order(maker, uint64(lots), uint128(pricePerLot), isBid, true));
        emit OrderCreated(id, maker, isBid, lots, pricePerLot);
    }

    /// @dev Validates a buy against listing `id` and returns its ETH cost (payment is checked before any transfer).
    function _quote(uint256 id, uint256 lots) internal view returns (uint256) {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.isBid) revert WrongSide();
        if (lots == 0 || lots > o.lots) revert BadParams();
        return lots * o.pricePerLot;
    }

    /// @dev Fill part of a listing for msg.sender (caller already checked payment).
    function _buy(uint256 id, uint256 lots) internal {
        uint256 cost = _quote(id, lots); // re-validate: the same id may appear twice in buyMany
        Order storage o = orders[id];
        o.lots -= uint64(lots);
        if (o.lots == 0) o.active = false;
        address seller = o.maker;
        uint256 fee = (cost * feeBps) / 10_000;

        if (!token.transfer(msg.sender, lots * lotSize)) revert TokenTransferFailed();
        _sendEth(seller, cost - fee);
        if (fee > 0) _sendEth(feeRecipient, fee);

        emit Trade(id, msg.sender, seller, lots, o.pricePerLot, cost, fee, block.timestamp);
    }

    function _sendEth(address to, uint256 value) internal {
        (bool ok, ) = to.call{value: value}("");
        if (!ok) revert EthTransferFailed();
    }
}
