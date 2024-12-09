import {
    Character,
    Clients,
    ModelProviderName,
    defaultCharacter,
} from "@ai16z/eliza";

export const character: Character = {
    ...defaultCharacter,
    name: "MAIrc AIndreessen",
    username: "pmairca",
    modelProvider: ModelProviderName.OPENAI,
    plugins: [],
    clients: [Clients.TELEGRAM],
};
