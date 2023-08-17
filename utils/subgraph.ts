const SUBGRAPH_URL = "https://api.thegraph.com/subgraphs/name/webmaster-tribe3/tribe3-whitelist-mainnet";
const GRAPH_QUERY_LIMIT = 1000;

const getAmmPositions = async (ammAddr: string, timestampFrom: number) => {
  const events = await fetch(SUBGRAPH_URL, {
    method: "POST",
    body: JSON.stringify({
      query: `{ 
                ammPositions(
                  first: ${GRAPH_QUERY_LIMIT},
                  where: {timestamp_gt: ${timestampFrom}, amm: "${ammAddr.toLowerCase()}", positionSize_not: 0},
                  orderBy: timestamp, 
                  orderDirection: asc,
                ){
                  amm
                  timestamp
                  trader
                }
              }`,
    }),
  })
    .then((res) => res.json() as any)
    .then((resJson) => resJson.data.ammPositions);
  return events;
};

const getFullAmmPositions = async (ammAddr: string) => {
  let data: any[] = [];
  let qData = await getAmmPositions(ammAddr, 0);
  data = data.concat(qData);
  while (qData.length === GRAPH_QUERY_LIMIT) {
    qData = await getAmmPositions(ammAddr, data[data.length - 1].timestamp);
    data = data.concat(qData);
  }
  return data;
};

export const getAmmTraders = async (ammAddr: string) => {
  const events = (await getFullAmmPositions(ammAddr)) as any[];
  return events.map((evt) => evt.trader);
};
