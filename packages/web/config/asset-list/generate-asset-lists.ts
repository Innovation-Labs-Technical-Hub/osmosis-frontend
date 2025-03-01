/**
 * This file is used to generate the asset-list.ts and chain-list.ts files.
 *
 * Reasons we need to generate chain-list.ts:
 *  1. We need to add the `keplrChain` object to the chain list. This is used to keep compatibility with the Keplr stores.
 *  2. We need to determine all the available chain ids for added type safety.
 *
 * Reasons we need to generate asset-list.ts:
 *  1. We need to add the `origin_chain_id` and `origin_chain_name` to the asset list.
 *     This makes it easier to find the source chain for an asset and register it on our observable assets store.
 *  2. We need to determine all the available asset symbols for added type safety.
 */

// eslint-disable-next-line import/no-extraneous-dependencies
import type {
  Asset,
  AssetList,
  Chain,
  ChainList,
  ResponseAssetList,
} from "@osmosis-labs/types";
import { getMinimalDenomFromAssetList } from "@osmosis-labs/utils";
import * as fs from "fs";
import path from "path";
// eslint-disable-next-line import/no-extraneous-dependencies
import * as prettier from "prettier";

import {
  IS_TESTNET,
  OSMOSIS_CHAIN_ID_OVERWRITE,
  OSMOSIS_CHAIN_NAME_OVERWRITE,
} from "~/config/env";
import { PoolPriceRoutes } from "~/config/price";
import { queryGithubFile } from "~/server/queries/github";

import { downloadAndSaveImage, getChainList } from "./utils";

const repo = "osmosis-labs/assetlists";

function getOsmosisChainId(environment: "testnet" | "mainnet") {
  return environment === "testnet" ? "osmo-test-5" : "osmosis-1";
}

function getFilePath({
  chainId,
  fileType,
}: {
  chainId: string;
  fileType: "assetlist" | "chainlist";
}) {
  return `/${chainId}/${chainId}.${fileType}.json`;
}

async function generateChainListFile({
  assetLists,
  chainList,
  environment,
  overwriteFile,
  onlyTypes,
}: {
  assetLists: AssetList[];
  chainList: ChainList;
  environment: "testnet" | "mainnet";
  /**
   * If true, will only include types for available chains.
   */
  onlyTypes: boolean;
  /**
   * If true, will overwrite file.
   */
  overwriteFile: boolean;
}) {
  const allAvailableChains: Pick<Chain, "chain_id" | "chain_name">[] = [
    ...chainList.chains,
    ...(OSMOSIS_CHAIN_ID_OVERWRITE && OSMOSIS_CHAIN_NAME_OVERWRITE
      ? [
          {
            chain_id: OSMOSIS_CHAIN_ID_OVERWRITE,
            chain_name: OSMOSIS_CHAIN_NAME_OVERWRITE,
          },
        ]
      : []),
  ];

  let content: string = "";

  const chainIdTypeName =
    environment === "mainnet" ? "MainnetChainIds" : "TestnetChainIds";

  if (!onlyTypes) {
    content += `
      import type { Chain, ChainInfoWithExplorer } from "@osmosis-labs/types";
      export const ChainList: ( Omit<Chain, "chain_id"> & { chain_id: ${chainIdTypeName}; keplrChain: ChainInfoWithExplorer})[] = ${JSON.stringify(
      getChainList({ assetLists, environment, chains: chainList.chains }),
      null,
      2
    )};
    `;
  }

  content += `
    export type ${chainIdTypeName} = ${Array.from(
    new Set(allAvailableChains.map((c) => c.chain_id))
  )
    .map(
      (chainId) =>
        `"${chainId}" /** ${
          allAvailableChains.find((c) => c.chain_id === chainId)!.chain_name
        } */`
    )
    .join(" | ")};
  `;

  const prettierConfig = await prettier.resolveConfig("./");
  const formatted = prettier.format(content, {
    ...prettierConfig,
    parser: "typescript",
  });

  const dirPath = "config/generated";
  const fileName = "chain-list.ts";

  try {
    const filePath = path.join(dirPath, fileName);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath);
    }

    if (!overwriteFile) {
      fs.appendFileSync(filePath, formatted, {
        encoding: "utf8",
        flag: "a",
      });
      console.info(`Successfully appended to ${fileName}`);
      return;
    }

    fs.writeFileSync(filePath, formatted, {
      encoding: "utf8",
      flag: "w",
    });
    console.info(`Successfully wrote ${fileName}`);
  } catch (e) {
    console.error(`Error writing ${fileName}: ${e}`);
  }
}

function createOrAddToAssetList(
  assetList: AssetList[],
  chain: Chain,
  asset: ResponseAssetList["assets"][number]
): AssetList[] {
  const assetlistIndex = assetList.findIndex(
    ({ chain_name }) => chain_name === chain.chain_name
  );

  const augmentedAsset: Asset = {
    ...asset,
    display: asset.display,
    origin_chain_id: chain.chain_id,
    origin_chain_name: chain.chain_name,
    price_coin_id: PoolPriceRoutes.find(
      ({ spotPriceSourceDenom }) => spotPriceSourceDenom === asset.base
    )?.alternativeCoinId,
  };

  if (assetlistIndex === -1) {
    assetList.push({
      chain_name: chain.chain_name,
      chain_id: chain.chain_id,
      assets: [augmentedAsset],
    });
  } else {
    assetList[assetlistIndex].assets.push(augmentedAsset);
  }

  return assetList;
}

async function generateAssetListFile({
  chains,
  environment,
  overwriteFile,
  onlyTypes,
}: {
  chains: Chain[];
  environment: "testnet" | "mainnet";
  /**
   * If true, will only include types for available assets.
   */
  onlyTypes: boolean;
  /**
   * If true, will overwrite file.
   */
  overwriteFile: boolean;
}) {
  const osmosisChainId = getOsmosisChainId(environment);
  const assetList = await queryGithubFile<ResponseAssetList>({
    repo,
    filePath: getFilePath({
      chainId: osmosisChainId,
      fileType: "assetlist",
    }),
  });

  const assetLists = assetList.assets.reduce<AssetList[]>((acc, asset) => {
    const traces = asset.traces.filter((trace) =>
      ["ibc", "ibc-cw20"].includes(trace.type)
    );

    /** If there are no traces, assume it's an Osmosis asset */
    if (traces.length === 0) {
      const chain = chains.find((chain) => chain.chain_id === osmosisChainId);

      if (!chain) {
        throw new Error("Failed to find chain osmosis");
      }

      return createOrAddToAssetList(acc, chain, asset);
    }

    for (const trace of traces) {
      const chainName = trace.counterparty.chain_name;
      const chain = chains.find((chain) => chain.chain_name === chainName);

      if (!chain) {
        console.warn(
          `Failed to find chain ${chainName}. ${asset.symbol} for that chain will be skipped.`
        );
        continue;
      }

      createOrAddToAssetList(acc, chain, asset);
    }

    return acc;
  }, [] as AssetList[]);

  let content: string = "";

  if (!onlyTypes) {
    content += `
      import type { AssetList } from "@osmosis-labs/types";
      export const AssetLists: AssetList[] = ${JSON.stringify(
        assetLists,
        null,
        2
      )};    
    `;
  }

  content += `    
    export type ${
      environment === "testnet" ? "TestnetAssetSymbols" : "MainnetAssetSymbols"
    } = ${Array.from(new Set(assetList.assets.map((asset) => asset.symbol)))
    .map(
      (symbol) =>
        `"${symbol}" /** minDenom: ${getMinimalDenomFromAssetList(
          assetList.assets.find((asset) => asset.symbol === symbol)!
        )} */`
    )
    .join(" | ")};
  `;

  const prettierConfig = await prettier.resolveConfig("./");
  const formatted = prettier.format(content, {
    ...prettierConfig,
    parser: "typescript",
  });

  const dirPath = "config/generated";
  const fileName = "asset-lists.ts";
  const addedAssetsSize = assetLists
    .flatMap(({ assets }) => assets)
    .reduce((acc, asset) => {
      acc.add(asset.symbol);
      return acc;
    }, new Set()).size;

  try {
    const filePath = path.join(dirPath, fileName);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath);
    }

    if (!overwriteFile) {
      fs.appendFileSync(filePath, formatted, {
        encoding: "utf8",
        flag: "a",
      });
      console.info(`Successfully appended to ${fileName}.`);
      return assetLists;
    }

    fs.writeFileSync(filePath, formatted, {
      encoding: "utf8",
      flag: "w",
    });

    console.info(
      `Successfully wrote ${fileName}. Added ${addedAssetsSize} assets.`
    );

    return assetLists;
  } catch (e) {
    console.error(`Error writing ${fileName}: ${e}`);
  }
}

async function generateAssetImages({
  environment,
}: {
  environment: "testnet" | "mainnet";
}) {
  const osmosisChainId = getOsmosisChainId(environment);
  const assetList = await queryGithubFile<ResponseAssetList>({
    repo,
    filePath: getFilePath({
      chainId: osmosisChainId,
      fileType: "assetlist",
    }),
  });

  console.time("Successfully downloaded images.");
  for await (const asset of assetList.assets) {
    await downloadAndSaveImage(
      asset?.logo_URIs.svg ?? asset?.logo_URIs.png ?? "",
      asset
    );
  }
  console.timeEnd("Successfully downloaded images.");
}

async function main() {
  const [mainnetChainList, testnetChainList] = await Promise.all([
    queryGithubFile<ChainList>({
      repo,
      filePath: getFilePath({
        chainId: getOsmosisChainId("mainnet"),
        fileType: "chainlist",
      }),
    }),
    queryGithubFile<ChainList>({
      repo,
      filePath: getFilePath({
        chainId: getOsmosisChainId("testnet"),
        fileType: "chainlist",
      }),
    }),
    generateAssetImages({ environment: IS_TESTNET ? "testnet" : "mainnet" }),
  ]);

  let mainnetAssetLists: AssetList[] | undefined;
  let testnetAssetLists: AssetList[] | undefined;

  /**
   * If testnet, generate testnet asset list first to avoid overwriting the mainnet types.
   */
  if (IS_TESTNET) {
    testnetAssetLists = await generateAssetListFile({
      chains: testnetChainList.chains,
      environment: "testnet",
      overwriteFile: true,
      onlyTypes: false,
    });
    mainnetAssetLists = await generateAssetListFile({
      chains: mainnetChainList.chains,
      environment: "mainnet",
      overwriteFile: false,
      onlyTypes: true,
    });
  } else {
    mainnetAssetLists = await generateAssetListFile({
      chains: mainnetChainList.chains,
      environment: "mainnet",
      overwriteFile: true,
      onlyTypes: false,
    });
    testnetAssetLists = await generateAssetListFile({
      chains: testnetChainList.chains,
      environment: "testnet",
      overwriteFile: false,
      onlyTypes: true,
    });
  }

  if (!mainnetAssetLists || !testnetAssetLists)
    throw new Error("Failed to generate asset lists");

  /**
   * If testnet, generate testnet chain list first to avoid overwriting the mainnet types.
   */
  if (IS_TESTNET) {
    await generateChainListFile({
      assetLists: testnetAssetLists,
      chainList: testnetChainList,
      environment: "testnet",
      onlyTypes: false,
      overwriteFile: true,
    });
    await generateChainListFile({
      assetLists: mainnetAssetLists,
      chainList: mainnetChainList,
      environment: "mainnet",
      onlyTypes: true,
      overwriteFile: false,
    });
  } else {
    await generateChainListFile({
      assetLists: mainnetAssetLists,
      chainList: mainnetChainList,
      environment: "mainnet",
      onlyTypes: false,
      overwriteFile: true,
    });
    await generateChainListFile({
      assetLists: testnetAssetLists,
      chainList: testnetChainList,
      environment: "testnet",
      onlyTypes: true,
      overwriteFile: false,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
