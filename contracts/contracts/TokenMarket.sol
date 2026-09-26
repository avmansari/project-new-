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
 *  Offers:                buyer escrows ETH for a specific listing at their own price -> the seller can accept.
 *
 *  - Price is "wei per lot"; every trade costs exactly lots * pricePerLot (no rounding).
 *  - Expiry: orders and offers can expire (e.g. 24h / 7d). Expired ones can't be filled; the maker can cancel,
 *    and ANYONE can call reclaimExpired / reclaimExpiredOffer to send the funds back to the maker (auto-cancel).
 *  - Marketplace fee (basis points, default 2%, max 5%) taken from the ETH side, sent to feeRecipient.
 */
contract TokenMarket {
    IERC20 public immutable token;
    uint256 public immutable lotSize; // token units per lot (18 decimals)
    address public owner;
    address public feeRecipient;
    uint256 public feeBps; // 200 = 2%
    uint256 public constant MAX_FEE_BPS = 500;

    struct Order {
        address maker;
        uint64 lots; // remaining whole lots
        uint128 pricePerLot; // wei per lot
        uint64 expiry; // unix time; 0 = never expires
        bool isBid; // false = sell listing, true = buy bid
        bool active;
    }

    struct Offer {
        address buyer;
        uint64 listingId;
        uint64 lots;
        uint128 pricePerLot; // offered wei per lot (ETH escrowed = lots * pricePerLot)
        uint64 expiry; // 0 = never
        bool active;
    }

    Order[] public orders;
    Offer[] public offers;

    event OrderCreated(uint256 indexed id, address indexed maker, bool isBid, uint256 lots, uint256 pricePerLot, uint256 expiry);
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
    event OfferMade(uint256 indexed offerId, uint256 indexed listingId, address indexed buyer, uint256 lots, uint256 pricePerLot, uint256 expiry);
    event OfferCancelled(uint256 indexed offerId, address indexed buyer);
    event OfferAccepted(uint256 indexed offerId, uint256 indexed listingId);
    event FeeUpdated(uint256 feeBps, address feeRecipient);

    error NotOwner();
    error BadParams();
    error OrderClosed();
    error Expired();
    error NotExpired();
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

    /// @notice List `lots` whole lots for sale until `expiry` (0 = never). Requires token.approve(market, lots * lotSize).
    function list(uint256 lots, uint256 pricePerLot, uint256 expiry) external nonReentrant returns (uint256 id) {
        _checkOrder(lots, pricePerLot, expiry);
        if (!token.transferFrom(msg.sender, address(this), lots * lotSize)) revert TokenTransferFailed();
        id = _push(msg.sender, lots, pricePerLot, expiry, false);
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

    /// @notice Place a bid for `lots` whole lots at `pricePerLot` until `expiry` (0 = never); escrows lots * pricePerLot ETH.
    function bid(uint256 lots, uint256 pricePerLot, uint256 expiry) external payable nonReentrant returns (uint256 id) {
        _checkOrder(lots, pricePerLot, expiry);
        uint256 cost = lots * pricePerLot;
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);
        id = _push(msg.sender, lots, pricePerLot, expiry, true);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Sell `lots` whole lots into bid `id`. Requires token.approve(market, lots * lotSize) first.
    function sell(uint256 id, uint256 lots) external nonReentrant {
        Order storage o = orders[id];
        _requireLive(o);
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
    // Offers on a specific listing
    // ------------------------------------------------------------------

    /// @notice Offer `pricePerLot` for `lots` of listing `listingId` (ETH is escrowed). The seller may accept.
    function makeOffer(uint256 listingId, uint256 lots, uint256 pricePerLot, uint256 expiry)
        external
        payable
        nonReentrant
        returns (uint256 offerId)
    {
        Order storage o = orders[listingId];
        _requireLive(o);
        if (o.isBid) revert WrongSide();
        if (o.maker == msg.sender) revert BadParams();
        _checkOrder(lots, pricePerLot, expiry);
        if (lots > o.lots) revert BadParams();
        uint256 cost = lots * pricePerLot;
        if (msg.value < cost) revert InsufficientPayment(cost, msg.value);

        offerId = offers.length;
        offers.push(Offer(msg.sender, uint64(listingId), uint64(lots), uint128(pricePerLot), uint64(expiry), true));
        emit OfferMade(offerId, listingId, msg.sender, lots, pricePerLot, expiry);
        if (msg.value > cost) _sendEth(msg.sender, msg.value - cost);
    }

    /// @notice Seller accepts an offer on their listing: lots go to the buyer, escrowed ETH (minus fee) to the seller.
    function acceptOffer(uint256 offerId) external nonReentrant {
        Offer storage f = offers[offerId];
        if (!f.active) revert OrderClosed();
        if (f.expiry != 0 && block.timestamp >= f.expiry) revert Expired();
        Order storage o = orders[f.listingId];
        _requireLive(o);
        if (o.maker != msg.sender) revert NotMaker();
        if (f.lots > o.lots) revert BadParams();

        uint256 value = uint256(f.lots) * f.pricePerLot;
        f.active = false;
        o.lots -= f.lots;
        if (o.lots == 0) o.active = false;
        uint256 fee = (value * feeBps) / 10_000;

        if (!token.transfer(f.buyer, uint256(f.lots) * lotSize)) revert TokenTransferFailed();
        _sendEth(msg.sender, value - fee);
        if (fee > 0) _sendEth(feeRecipient, fee);

        emit OfferAccepted(offerId, f.listingId);
        emit Trade(f.listingId, f.buyer, msg.sender, f.lots, f.pricePerLot, value, fee, block.timestamp);
    }

    /// @notice Buyer withdraws an offer (any time) and gets the escrowed ETH back.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage f = offers[offerId];
        if (!f.active) revert OrderClosed();
        if (f.buyer != msg.sender) revert NotMaker();
        _closeOffer(offerId, f);
    }

    /// @notice Anyone can return an expired offer's ETH to its buyer (auto-cancel).
    function reclaimExpiredOffer(uint256 offerId) external nonReentrant {
        Offer storage f = offers[offerId];
        if (!f.active) revert OrderClosed();
        if (f.expiry == 0 || block.timestamp < f.expiry) revert NotExpired();
        _closeOffer(offerId, f);
    }

    // ------------------------------------------------------------------
    // Both sides
    // ------------------------------------------------------------------

    /// @notice Cancel your order (also after expiry); unfilled lots (listing) or ETH (bid) are returned.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.maker != msg.sender) revert NotMaker();
        _close(id, o);
    }

    /// @notice Anyone can return an expired order's funds to its maker (auto-cancel / cleanup).
    function reclaimExpired(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (!o.active) revert OrderClosed();
        if (o.expiry == 0 || block.timestamp < o.expiry) revert NotExpired();
        _close(id, o);
    }

    function ordersCount() external view returns (uint256) {
        return orders.length;
    }

    function offersCount() external view returns (uint256) {
        return offers.length;
    }

    /// @notice Page through orders for UIs: returns orders[from .. from+count).
    function getOrders(uint256 from, uint256 count) external view returns (Order[] memory out) {
        uint256 n = orders.length;
        if (from >= n) return new Order[](0);
        uint256 end = from + count > n ? n : from + count;
        out = new Order[](end - from);
        for (uint256 i = from; i < end; i++) out[i - from] = orders[i];
    }

    /// @notice Page through offers for UIs: returns offers[from .. from+count).
    function getOffers(uint256 from, uint256 count) external view returns (Offer[] memory out) {
        uint256 n = offers.length;
        if (from >= n) return new Offer[](0);
        uint256 end = from + count > n ? n : from + count;
        out = new Offer[](end - from);
        for (uint256 i = from; i < end; i++) out[i - from] = offers[i];
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
    function _checkOrder(uint256 lots, uint256 pricePerLot, uint256 expiry) internal view {
        if (lots == 0 || pricePerLot == 0 || lots > type(uint64).max || pricePerLot > type(uint128).max) revert BadParams();
        if (expiry != 0 && (expiry <= block.timestamp || expiry > type(uint64).max)) revert BadParams();
    }

    function _requireLive(Order storage o) internal view {
        if (!o.active) revert OrderClosed();
        if (o.expiry != 0 && block.timestamp >= o.expiry) revert Expired();
    }

    function _push(address maker, uint256 lots, uint256 pricePerLot, uint256 expiry, bool isBid) internal returns (uint256 id) {
        id = orders.length;
        orders.push(Order(maker, uint64(lots), uint128(pricePerLot), uint64(expiry), isBid, true));
        emit OrderCreated(id, maker, isBid, lots, pricePerLot, expiry);
    }

    function _close(uint256 id, Order storage o) internal {
        uint256 left = o.lots;
        address maker = o.maker;
        o.active = false;
        o.lots = 0;
        if (o.isBid) {
            _sendEth(maker, left * o.pricePerLot);
        } else if (!token.transfer(maker, left * lotSize)) {
            revert TokenTransferFailed();
        }
        emit OrderCancelled(id, maker, left);
    }

    function _closeOffer(uint256 offerId, Offer storage f) internal {
        f.active = false;
        uint256 refund = uint256(f.lots) * f.pricePerLot;
        _sendEth(f.buyer, refund);
        emit OfferCancelled(offerId, f.buyer);
    }

    /// @dev Validates a buy against listing `id` and returns its ETH cost (payment is checked before any transfer).
    function _quote(uint256 id, uint256 lots) internal view returns (uint256) {
        Order storage o = orders[id];
        _requireLive(o);
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
