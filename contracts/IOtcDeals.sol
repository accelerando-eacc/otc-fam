// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IOtcDeals {
    enum Status { None, Open, Filled, Cancelled }
    struct Deal {
        address maker;      // who offers
        address taker;      // who may fill; address(0) = anyone
        address sellToken;  // what the maker gives
        uint256 sellAmount;
        address buyToken;   // what the maker wants
        uint256 buyAmount;
        uint64 expiry;      // unix seconds; a fill at or after it fails
        Status status;
    }
    event DealCreated(uint256 indexed id, address indexed maker, address indexed taker);
    event DealFilled(uint256 indexed id, address indexed taker);
    event DealCancelled(uint256 indexed id);

    function createDeal(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry) external returns (uint256 id);
    function fill(uint256 id) external;
    function cancel(uint256 id) external;
    function getDeal(uint256 id) external view returns (Deal memory);
}
