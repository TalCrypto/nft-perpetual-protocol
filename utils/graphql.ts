import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { request, gql, RequestDocument } from "graphql-request";
import { network } from "hardhat";

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

export const queryTraders = async (amm: string) => {
  const data = await doGraphRequest(tradersOfAmmQuery, {
    ammAddress: amm,
  });
  return data;
};

export const doGraphRequest = (query: RequestDocument, variables = {}) =>
  new Promise((resolve, reject) => {
    request(APIURL, query, variables)
      .then((data) => resolve(data))
      .catch((err) => reject(err));
  });
