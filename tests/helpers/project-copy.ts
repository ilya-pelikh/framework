import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises"
import { resolve, relative } from "node:path"

export async function projectCopy() {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(resolve(".cache/project-"))
  for (const name of ["apps", "packages", "scripts", "package.json", "tsconfig.json", "types.d.ts"]) {
    await cp(resolve(name), resolve(directory, name), {
      recursive: true,
      filter: (path) =>
        !relative(process.cwd(), path)
          .split(/[\\/]/)
          .some((part) => ["dist", "node_modules", ".cache"].includes(part)),
    })
  }
  await symlink(resolve("node_modules"), resolve(directory, "node_modules"), "junction")
  return directory
}
