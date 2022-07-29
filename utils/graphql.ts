import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { createClient } from "urql";

const queryTradersOfAmm = `
  query($ammAddress: Address) {
    ammPositions(where: {amm: $ammAddress, positionSize_not: 0}) {
      trader
    }
  }
`;

const APIURL = process.env.SUBGRAPH_API_URL || "https://api.thegraph.com/subgraphs/name/username/subgraphname";

const client = createClient({
  url: APIURL,
});

export const queryTraders = async (amm: string) => {
  const { data } = await client.query(queryTradersOfAmm).toPromise();
  return data;
};
