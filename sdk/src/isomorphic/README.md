# Isomorphic Code Explanation

Soem of the features you might want to add to the SDK may only be compatible with particular execution environments (usually a non-browser one). To get that working without breaking the SDK for people in other environments, you need to get your code working in an isomorphic way.

This README will try explain how to do this, and you should be able to follow the example of other pieces of isomorphic code in this folder.

## High Level Explanation

At a high level, we just want to make sure that we're not importing any incompatible code into the final compiled .js output files. The only real way this can "get done" is by importing types or by importing classes/methods/values out of an offending packages. The goal of our isomorphic seperation is to ensure that we have SDK-Side code which is still properly typed and easy for devs to work with, without putting anything bad into the output code. We will do this with some typescript magic and a simple but handy postbuild script.

## Step-by-step isomorphic code:

1. Create [your-package-name].d.ts, [your-package-name].browser.ts, and [your-package-name].node.ts files.
2. Remove any imports of an offending library which aren't going through our dedicated isomorphic files. Instead import the TYPES of these and place them in the `.d.ts` file (definition file). Note to import ONLY THE TYPES you use `import type {stuff}` instead of just `import {stuff}`.
3. The definition file should be exporting types only, and the files that were previously importing things directly from the library should be able to import from the definition file now instead. You might see some typescript issues when you import things from this definition file because typescript thinks it's "just a type" -- you can safely @ts-ignore these errors, but the types SHOULD at least be correct when you are using them.
4. For concrete classes, methods, constants, etc. that you need to make available - you will place them in the `.browser` and `.node` files. You should be able to pretty flexibly export them however you want, just make sure the definition file has a matching type for how you're doing it. See `grpc.d.ts` and `grpc.node.ts` to look at how we're doing this for `createClient`. For the "bad" isomorphic file it's probably best to throw an error so that the consumer knows they shouldn't be using this particular feature.
5. Note about enums :: they're weird and annoying. If you follow how the enum type `CommitmentLevel` was exported for the grpc package though you should be fine.
6. Add the name of your package to `postbuild.js`.
7. when you run `build` it will build the node version of all of these packages. You can run `build:browser` to build the browser side ones instead.
