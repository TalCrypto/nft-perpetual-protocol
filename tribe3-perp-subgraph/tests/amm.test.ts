import {
  assert,
  describe,
  test,
  clearStore,
  beforeAll,
  afterAll
} from "matchstick-as/assembly/index"
import { BigInt, Address } from "@graphprotocol/graph-ts"
import { CapChanged } from "../generated/schema"
import { CapChanged as CapChangedEvent } from "../generated/Amm/Amm"
import { handleCapChanged } from "../src/amm"
import { createCapChangedEvent } from "./amm-utils"

// Tests structure (matchstick-as >=0.5.0)
// https://thegraph.com/docs/en/developer/matchstick/#tests-structure-0-5-0

describe("Describe entity assertions", () => {
  beforeAll(() => {
    let maxHoldingBaseAsset = BigInt.fromI32(234)
    let openInterestNotionalCap = BigInt.fromI32(234)
    let newCapChangedEvent = createCapChangedEvent(
      maxHoldingBaseAsset,
      openInterestNotionalCap
    )
    handleCapChanged(newCapChangedEvent)
  })

  afterAll(() => {
    clearStore()
  })

  // For more test scenarios, see:
  // https://thegraph.com/docs/en/developer/matchstick/#write-a-unit-test

  test("CapChanged created and stored", () => {
    assert.entityCount("CapChanged", 1)

    // 0xa16081f360e3847006db660bae1c6d1b2e17ec2a is the default address used in newMockEvent() function
    assert.fieldEquals(
      "CapChanged",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a-1",
      "maxHoldingBaseAsset",
      "234"
    )
    assert.fieldEquals(
      "CapChanged",
      "0xa16081f360e3847006db660bae1c6d1b2e17ec2a-1",
      "openInterestNotionalCap",
      "234"
    )

    // More assert options:
    // https://thegraph.com/docs/en/developer/matchstick/#asserts
  })
})
