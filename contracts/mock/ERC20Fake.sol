// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

import { ERC20PresetMinterPauserUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/presets/ERC20PresetMinterPauserUpgradeable.sol";

// TODO rename to UpgradableMintableERC20
contract ERC20Fake is ERC20PresetMinterPauserUpgradeable {
    function initializeERC20Fake(
        uint256 initialSupply,
        string memory name,
        string memory symbol,
        uint8
    ) public initializer {
        __ERC20PresetMinterPauser_init(name, symbol);
        //_setupDecimals(decimal);
        _mint(_msgSender(), initialSupply);
    }
}
