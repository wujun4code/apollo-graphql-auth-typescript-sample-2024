import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { GraphQLError } from 'graphql';
import DataLoader from 'dataloader';

class UserDataSource {

    constructor() {
    }

    demoUsers = [
        { username: 'admin', id: 1, token: 'adpwd123', roles: ['admin', 'editor'] },
        { username: 'alice', id: 2, token: 'apwd123', roles: ['editor'] },
        { username: 'bob', id: 3, token: 'bpwd123', roles: ['reader'] },
    ];

    private batchUsers = new DataLoader(async (token: string[]) => {

        const productIdToProductMap = this.demoUsers.reduce((mapping, user) => {
            mapping[user.token] = user;
            return mapping;
        }, {});
        return token.map((token) => productIdToProductMap[token]);
    });

    async getUserFor(token) {
        return this.batchUsers.load(token);
    }
}

class ACL {
    hasPermission = (item: { acl }, user: { roles }, operation: 'read' | 'write') => {
        if (!item.acl) return true;
        if (item.acl['*'][operation] == true) {
            return true;
        }
        if (!user.roles) return false;
        user.roles.forEach(role => {
            const roleKey = `role:${role}`;
            if (roleKey in item.acl && item.acl[`role:${role}`][operation] == true) return true;
        });

        return false;
    };

    hasRole = (user: { roles }, roles: []) => {
        return roles.some(item => user.roles.includes(item));
    }
}

const demoArticles = [
    {
        title: 'AAA', id: 1, content: 'aaa', lastEditedBy: 2,
        acl: {
            "*": { read: true },
            "role:editor": [
                { read: true },
                { write: true }
            ],
            "role:admin": [
                { read: true },
                { write: true }
            ],
        }
    },
    {
        title: 'BBB ', id: 2, content: 'bbb', lastEditedBy: 2,
        acl: {
            "*": { read: true },
            "role:editor": [
                { read: true },
                { write: true }
            ],
        }
    },
    {
        title: 'CCC', id: 3, content: 'ccc', lastEditedBy: 2,
        acl: {
            "*": { read: false },
            "role:admin": [
                { read: true },
                { write: true }
            ]
        }
    },
];

class ArticleDataSource {

    acl: ACL;
    constructor(acl: ACL) {
        this.acl = acl;
    }

    private batchArticles = new DataLoader(async (ids: number[]) => {

        const productIdToProductMap = demoArticles.reduce((mapping, article) => {
            mapping[article.id] = article;
            return mapping;
        }, {});
        return ids.map((id) => productIdToProductMap[id]);
    });

    async getArticleFor(id) {
        return this.batchArticles.load(id);
    }

    async listArticles(user: { roles }) {
        return demoArticles.filter(article => {
            return this.acl.hasPermission(article, user, 'read');
        });
    }

    async editArticle(article, user) {
        this.batchArticles.clear(article.id);

        const foundIndex = demoArticles.findIndex(x => x.id == article.id);
        if (foundIndex < 0) throw new GraphQLError('404 Not Found', {
            extensions: {
                code: 'Not Found',
            },
        })
        const foundItem = demoArticles[foundIndex];
        foundItem.lastEditedBy = user.id;
        foundItem.content = article.content;
        foundItem.title = article.title;

        this.batchArticles.prime(article.id, foundItem)

        return await this.getArticleFor(foundItem.id);
    }
}

interface UserInterface {
    name: string;
    roles: [];
}

interface MyContext {
    // we'd define the properties a user should have
    // in a separate user interface (e.g., email, id, url, etc.)
    user: UserInterface;
    dataSources: {
        user: UserDataSource
        article: ArticleDataSource
        acl: ACL,

    }
}

export const typeDefs = `#graphql
  type Article {
    title: String!
    id: Int!
    content: String!
    lastEditedBy: Int!
  }

  type Query {
    listArticles: [Article]!
  }

  type Mutation {
    editArticle(id: Int!, title: String, content: String): Article
  }
`;

export const resolvers = {
    Query: {
        listArticles: async (parent, args, { user, dataSources }, info) => {
            return dataSources.article.listArticles(user);
        },
    },
    Mutation: {
        editArticle: async (parent, args, { user, dataSources: { acl, article } }, info) => {

            if (!user) throw new GraphQLError('401 Unauthorized', {
                extensions: {
                    code: 'Unauthorized',
                },
            });

            if (!acl.hasRole(user, ['admin', 'editor'])) {
                throw new GraphQLError('403 Forbidden', {
                    extensions: {
                        code: 'Forbidden',
                    },
                });
            }

            return article.editArticle({ id: args.id, title: args.title, content: args.content }, user);
        },
    }
}

const server = new ApolloServer<MyContext>({
    typeDefs,
    resolvers,
});

const { url } = await startStandaloneServer(server, {

    // Note: This example uses the `req` argument to access headers,
    // but the arguments received by `context` vary by integration.
    // This means they vary for Express, Fastify, Lambda, etc.

    // For `startStandaloneServer`, the `req` and `res` objects are
    // `http.IncomingMessage` and `http.ServerResponse` types.
    context: async ({ req, res }) => {
        // Get the user token from the headers.
        const token = req.headers.authorization || '';

        const userDataSource = new UserDataSource();
        const acl = new ACL();
        //Try to retrieve a user with the token
        const user = await userDataSource.getUserFor(token);
        // Add the user to the context
        return {
            user,
            dataSources: {
                // Create a new instance of our data source for every request!
                // (We pass in the database connection because we don't need
                // a new connection for every request.)
                user: userDataSource,
                acl: acl,
                article: new ArticleDataSource(acl),
            },
        };
    },
});


console.log(`🚀 Server listening at: ${url}`);