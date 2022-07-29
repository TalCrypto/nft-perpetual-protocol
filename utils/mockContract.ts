import { Signer } from "ethers";
import { AmmMock, AmmMock__factory } from "../typechain-types";

export async function deployAmmMock(signer: Signer): Promise<AmmMock> {
  const instance = await new AmmMock__factory(signer).deploy();
  return instance;
}
