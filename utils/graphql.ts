import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { ApolloClient, InMemoryCache, gql } from "@apollo/client";
import { network } from "hardhat";

const tradersOfAmmQuery = `
  query($ammAddress: Address) {
    ammPositions(where: {amm: $ammAddress, positionSize_not: 0}) {
      trader
    }
  }
`;

const APIURL =
  network.name == "localhost"
    ? "http://127.0.0.1:8000/subgraphs/name/tribe3-perp/graphql"
    : "https://api.thegraph.com/subgraphs/name/username/subgraphname";

const client = new ApolloClient({
  uri: APIURL,
  cache: new InMemoryCache(),
});

export const queryTraders = async (amm: string) => {
  const { data } = await client.query({
    query: gql(tradersOfAmmQuery),
    variables: {
      ammAddress: amm,
    },
  });
  return data;
};
