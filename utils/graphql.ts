import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { request, gql, RequestDocument } from "graphql-request";
import { network } from "hardhat";

interface Trader {
  trader: string;
}
interface AmmPositionTraderQueryResult {
  ammPositions: Array<Trader>;
}

const tradersOfAmmQuery = gql`
  query ($ammAddress: Bytes) {
    ammPositions(where: { amm: $ammAddress, positionSize_not: 0 }) {
      trader
    }
  }
`;

const APIURL =
  network.name == "localhost"
    ? "http://127.0.0.1:8000/subgraphs/name/tribe3-perp"
    : "https://api.thegraph.com/subgraphs/name/username/subgraphname";

export async function queryTraders(amm: string): Promise<Array<Trader>> {
  const data = (await doGraphRequest(tradersOfAmmQuery, {
    ammAddress: amm,
  })) as AmmPositionTraderQueryResult;
  return data.ammPositions;
}

export const doGraphRequest = (query: RequestDocument, variables = {}) =>
  new Promise((resolve, reject) => {
    request(APIURL, query, variables)
      .then((data) => resolve(data))
      .catch((err) => reject(err));
  });
