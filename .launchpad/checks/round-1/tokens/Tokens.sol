// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// The tokens round 1's checks trade with. They are the checks' own: never deploy them anywhere real.
// Anyone can mint. A transfer of more than the sender holds, or more than the spender may take, reverts.

abstract contract TokenBase {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory symbol_, uint8 decimals_) {
        name = symbol_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _approve(address spender, uint256 value) internal {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _spend(address from, uint256 value) internal {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
    }

    function _move(address from, address to, uint256 value) internal virtual {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// A plain ERC-20: every call answers true.
contract PlainToken is TokenBase {
    constructor(string memory symbol_, uint8 decimals_) TokenBase(symbol_, decimals_) {}

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spend(from, value);
        _move(from, to, value);
        return true;
    }
}

/// An awkward token, as USDT is on Ethereum: approve, transfer and transferFrom answer nothing at all.
contract NoReturnToken is TokenBase {
    constructor(string memory symbol_, uint8 decimals_) TokenBase(symbol_, decimals_) {}

    function approve(address spender, uint256 value) external {
        _approve(spender, value);
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        _spend(from, value);
        _move(from, to, value);
    }
}

/// A hostile token: once armed, its next transfer calls `target` with `data` (for example the deal
/// contract's fill or cancel) from inside the transfer, then goes on whatever that call answered.
contract ReentrantToken is PlainToken {
    address public target;
    bytes public data;
    bool public armed;
    /// Whether the call made from inside the transfer went through.
    bool public calledBack;

    constructor(string memory symbol_, uint8 decimals_) PlainToken(symbol_, decimals_) {}

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
        calledBack = false;
    }

    function _move(address from, address to, uint256 value) internal override {
        super._move(from, to, value);
        if (!armed) return;
        armed = false;
        (calledBack, ) = target.call(data);
    }
}
