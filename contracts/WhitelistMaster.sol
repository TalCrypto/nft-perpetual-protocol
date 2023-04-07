// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { BlockContext } from "./utils/BlockContext.sol";
import { IWhitelistMaster } from "./interfaces/IWhitelistMaster.sol";
import { OwnableUpgradeableSafe } from "./OwnableUpgradeableSafe.sol";

contract WhitelistMaster is IWhitelistMaster, OwnableUpgradeableSafe, BlockContext {
    mapping(address => bool) whitelist;

    function initialize() public initializer {
        __Ownable_init();
    }

    function addToWhitelist(address[] memory _addresses) external onlyOwner {
        uint256 len = _addresses.length;
        uint256 i;
        for (i; i < len; ) {
            if (!whitelist[_addresses[i]]) {
                whitelist[_addresses[i]] = true;
            }
            unchecked {
                i++;
            }
        }
    }

    function removeFromWhitelist(address[] memory _addresses) external onlyOwner {
        uint256 len = _addresses.length;
        uint256 i;
        for (i; i < len; ) {
            if (whitelist[_addresses[i]]) {
                whitelist[_addresses[i]] = false;
            }
            unchecked {
                i++;
            }
        }
    }

    function isWhitelisted(address _address) external view returns (bool) {
        return whitelist[_address];
    }
}
